import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64, fromBase64 } from '@/lib/pq/signature';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import { createDialogGate, type MessageLike } from '@/lib/data/dialogGate';
import type { UserCardRow } from '@/lib/data/types';

// Real crypto end to end: forged rows must fail because the math says so,
// not because a mock was told to say so.

const makeIdentity = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed || 1);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card: UserCardRow = {
		user_hash: userHash,
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `user-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	} as UserCardRow;
	(card as Record<string, unknown>).sign_b64 = signFields(card as never, sign.secretKey);
	return { sign, userHash, card, signPkeyB64: toBase64(sign.publicKey) };
};

const alice = makeIdentity(1);
const bob = makeIdentity(2);

const DIALOG = 'di_' + 'd'.repeat(128);
let msgCounter = 0;

/** Signed message row; refs travel out-of-band to the gate's decryptRefs mock. */
const makeMessage = (author: typeof alice, refs: Record<string, string>, tweak: Partial<MessageLike> = {}) => {
	const fields = {
		message_id: `dmsg_0199000${msgCounter++}`,
		dialog_hash: DIALOG,
		sender_hash: author.userHash,
		content_b64: toBase64(new Uint8Array([1, 2, 3, msgCounter])),
		deleted_flag: false,
		refs_map_b64: toBase64(new TextEncoder().encode(JSON.stringify(refs))),
		parent_sign_hash: null,
		owner_timestamp: 1_700_000_100 + msgCounter,
		...tweak,
	};
	const sign_b64 = signFields(fields as never, author.sign.secretKey);
	const row = { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) } as MessageLike;
	return { row, refs };
};

/** Gate wired to plaintext refs carried beside each row (no AES in these tests). */
// refs are keyed by REVISION: two revisions of one message (an edit) carry
// different refs maps, and keying by message_id would hand every revision the
// last one's map.
const makeGate = (opts: { cards?: Record<string, string>; refsOf: Map<string, Record<string, string> | 'no_key' | 'error'> }) =>
	createDialogGate({
		resolveSignPkey: async (userHash) => opts.cards?.[userHash] ?? null,
		decryptRefs: async (row) => opts.refsOf.get(row.sign_hash ?? row.message_id) ?? {},
	});

const refsByGate = new WeakMap<object, Map<string, Record<string, string> | 'no_key' | 'error'>>();
const gateWith = (...msgs: ReturnType<typeof makeMessage>[]) => {
	const refsOf = new Map(msgs.map((m) => [m.row.sign_hash!, m.refs] as const));
	const gate = makeGate({
		cards: { [alice.userHash]: alice.signPkeyB64, [bob.userHash]: bob.signPkeyB64 },
		refsOf,
	});
	refsByGate.set(gate, refsOf);
	return gate;
};
const gateWithShared = (gate: ReturnType<typeof gateWith>, ...more: ReturnType<typeof makeMessage>[]) => {
	const refsOf = refsByGate.get(gate)!;
	for (const m of more) refsOf.set(m.row.sign_hash!, m.refs);
	return gate;
};

describe('verifyUserCard — trust bootstrap', () => {
	it('accepts an honest self-signed card', () => {
		expect(verifyUserCard(alice.card).status).toBe('verified');
	});

	// user_hash is derived, never asserted: swapping in another key under the
	// same hash is the basic identity forgery this check exists for.
	it('rejects a card whose sign_pkey does not hash to its user_hash', () => {
		const forged = { ...bob.card, user_hash: alice.userHash };
		expect(verifyUserCard(forged)).toMatchObject({ status: 'invalid', reason: 'hash_mismatch' });
	});

	it('rejects a card whose signed field was altered', () => {
		const renamed = { ...alice.card, name: 'Mallory' };
		expect(verifyUserCard(renamed)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	// A broken cert would bind an attacker's KEM key to the victim's identity
	// — everything encrypted "to alice" would open under the attacker's key.
	it('rejects a card carrying a foreign crypt_cert', () => {
		const swapped = { ...alice.card, crypt_cert: bob.card.crypt_cert };
		expect(verifyUserCard(swapped)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});
});

describe('dialog gate — signature admission (T-INTEGRITY)', () => {
	it('admits an honest genesis message', async () => {
		const g = makeMessage(alice, {});
		const verdict = await gateWith(g).admit(g.row);
		expect(verdict).toMatchObject({ status: 'verified', dagVerified: true, isGenesis: true });
	});

	it('T-INTEGRITY-01: rejects a row whose content ciphertext was mutated', async () => {
		const g = makeMessage(alice, {});
		const tampered = { ...g.row, content_b64: toBase64(new Uint8Array([9, 9, 9])) };
		const verdict = await gateWith(g).admit(tampered);
		expect(verdict).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	// The signature covers the refs ciphertext blob, so causal reparenting
	// after the fact is tamper-evident even though the server can't see refs.
	it('T-INTEGRITY-02: rejects a row whose refs ciphertext was mutated', async () => {
		const g = makeMessage(alice, {});
		const tampered = { ...g.row, refs_map_b64: toBase64(new Uint8Array([7, 7])) };
		const verdict = await gateWith(g).admit(tampered);
		expect(verdict).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	it('T-INTEGRITY-03: rejects a row signed by a different key than its sender claims', async () => {
		const g = makeMessage(alice, {});
		const gate = makeGate({
			cards: { [alice.userHash]: bob.signPkeyB64 },
			refsOf: new Map([[g.row.sign_hash!, {}]]),
		});
		expect(await gate.admit(g.row)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	// sign_hash is derived from sign_b64, not covered by it; a lying value
	// would poison every reference pointing at this revision.
	it('rejects a row whose sign_hash does not derive from its signature', async () => {
		const g = makeMessage(alice, {});
		const lying = { ...g.row, sign_hash: 'dms_' + 'f'.repeat(128) };
		expect(await gateWith(g).admit(lying)).toMatchObject({ status: 'invalid', reason: 'sign_hash_mismatch' });
	});
});

describe('dialog gate — causal rules (T-DAG)', () => {
	it('T-DAG-01: two empty-scope messages are a valid root fork, admitted in either order, merged by the next', async () => {
		const g1 = makeMessage(alice, {});
		const g2 = makeMessage(alice, {});
		const merge = makeMessage(bob, { [g1.row.message_id]: g1.row.sign_hash!, [g2.row.message_id]: g2.row.sign_hash! });
		for (const order of [[g1, g2, merge], [g2, g1, merge], [merge, g2, g1]]) {
			const gate = gateWith(g1, g2, merge);
			for (const m of order) await gate.admit(m.row);
			for (const m of [g1, g2, merge]) expect(gate.isAdmitted(m.row.message_id, m.row.sign_hash!)).toBe(true);
			expect(gate.stats()).toMatchObject({ roots: 2, pending: 0, invalid: 0, blocked: 0 });
		}
	});

	it('T-DAG-01b: a child of a definitively invalid revision ends blocked, not waiting forever — transitively', async () => {
		const self0 = makeMessage(alice, {});
		const self = makeMessage(alice, {}, {});
		self.refs[self.row.message_id] = self.row.sign_hash!;
		const child = makeMessage(bob, { [self.row.message_id]: self.row.sign_hash! });
		const grandchild = makeMessage(alice, { [child.row.message_id]: child.row.sign_hash! });
		const gate = gateWith(self0, self, child, grandchild);

		expect(await gate.admit(grandchild.row)).toMatchObject({ status: 'waiting' });
		expect(await gate.admit(child.row)).toMatchObject({ status: 'waiting' });
		expect(await gate.admit(self.row)).toMatchObject({ status: 'invalid', reason: 'self_reference', terminal: true });
		expect(gate.getBlockedBy(child.row.message_id, child.row.sign_hash!)).toEqual([{ messageId: self.row.message_id, signHash: self.row.sign_hash }]);
		expect(gate.getBlockedBy(grandchild.row.message_id, grandchild.row.sign_hash!)).toEqual([{ messageId: child.row.message_id, signHash: child.row.sign_hash }]);
		expect(gate.stats()).toMatchObject({ pending: 0, blockedOnRefs: 0, blocked: 2 });
		const late = makeMessage(bob, { [grandchild.row.message_id]: grandchild.row.sign_hash! });
		expect(await gateWithShared(gate, late).admit(late.row)).toMatchObject({ status: 'blocked' });
	});

	it('T-DAG-01c: a forged presentation (bad signature) does not block — the genuine revision may still arrive', async () => {
		const parent = makeMessage(alice, {});
		const child = makeMessage(bob, { [parent.row.message_id]: parent.row.sign_hash! });
		const gate = gateWith(parent, child);
		expect(await gate.admit(child.row)).toMatchObject({ status: 'waiting' });
		const forged = { ...parent.row, content_b64: toBase64(new Uint8Array([9, 9, 9])) };
		expect(await gate.admit(forged)).toMatchObject({ status: 'invalid', reason: 'bad_signature', terminal: false });
		expect(gate.getBlockedBy(child.row.message_id, child.row.sign_hash!)).toBeNull();
		await gate.admit(parent.row);
		expect(gate.isAdmitted(child.row.message_id, child.row.sign_hash!)).toBe(true);
	});

	it('T-DAG-02: a fork and its merge all admit', async () => {
		const root = makeMessage(alice, {});
		const forkA = makeMessage(alice, { [root.row.message_id]: root.row.sign_hash! });
		const forkB = makeMessage(bob, { [root.row.message_id]: root.row.sign_hash! });
		const merge = makeMessage(alice, {
			[forkA.row.message_id]: forkA.row.sign_hash!,
			[forkB.row.message_id]: forkB.row.sign_hash!,
		});
		const gate = gateWith(root, forkA, forkB, merge);
		for (const m of [root, forkA, forkB, merge]) {
			expect((await gate.admit(m.row)).status).toBe('verified');
		}
	});

	it('T-DAG-04: unresolved refs wait, then admit when the parent lands', async () => {
		const parent = makeMessage(alice, {});
		const child = makeMessage(bob, { [parent.row.message_id]: parent.row.sign_hash! });
		const gate = gateWith(parent, child);

		const early = await gate.admit(child.row);
		expect(early).toMatchObject({ status: 'waiting' });
		expect((early as { missing: unknown[] }).missing).toHaveLength(1);
		expect(gate.isAdmitted(child.row.message_id, child.row.sign_hash!)).toBe(false);

		await gate.admit(parent.row);
		expect(gate.isAdmitted(child.row.message_id, child.row.sign_hash!)).toBe(true);
	});

	// The parent may verify while its refs stay unreadable (no key yet). Its
	// revision is still known — children waiting on it must not stay parked.
	it('drains children when the parent admits without a readable refs map', async () => {
		const parent = makeMessage(alice, {});
		const child = makeMessage(bob, { [parent.row.message_id]: parent.row.sign_hash! });
		const refsOf = new Map<string, Record<string, string> | 'no_key' | 'error'>([
			[parent.row.sign_hash!, 'no_key'],
			[child.row.sign_hash!, child.refs],
		]);
		const gate = makeGate({ cards: { [alice.userHash]: alice.signPkeyB64, [bob.userHash]: bob.signPkeyB64 }, refsOf });
		expect((await gate.admit(child.row)).status).toBe('waiting');
		expect((await gate.admit(parent.row)).status).toBe('verified');
		expect(gate.isAdmitted(child.row.message_id, child.row.sign_hash!)).toBe(true);
	});

	// The live bug: an edit archives the old revision into
	// dialog_messages_versions and the tip carries a new sign_hash — every
	// message whose refs pinned the pre-edit revision then waits forever
	// unless archived revisions count as known.
	it('resolves refs against an archived revision fed from the versions shape', async () => {
		const original = makeMessage(alice, {});                     // genesis, later edited
		const reply = makeMessage(bob, { [original.row.message_id]: original.row.sign_hash! });
		// the edited tip: same message_id, new sign_hash, refs recomputed
		const edited = makeMessage(alice, { [reply.row.message_id]: reply.row.sign_hash! },
			{ message_id: original.row.message_id, parent_sign_hash: original.row.sign_hash! });
		const gate = gateWith(original, reply, edited);

		// tips arriving: only the edited revision and the reply exist as tips
		expect((await gate.admit(reply.row)).status).toBe('waiting');   // pins the archived revision
		expect((await gate.admit(edited.row)).status).toBe('waiting');  // pins the reply

		// the versions shape delivers the archived revision → the chain drains
		expect((await gate.admit(original.row)).status).toBe('verified');
		expect(gate.isAdmitted(reply.row.message_id, reply.row.sign_hash!)).toBe(true);
		expect(gate.isAdmitted(edited.row.message_id, edited.row.sign_hash!)).toBe(true);
	});

	it('drains a whole chain delivered in reverse order', async () => {
		const a = makeMessage(alice, {});
		const b = makeMessage(bob, { [a.row.message_id]: a.row.sign_hash! });
		const c = makeMessage(alice, { [b.row.message_id]: b.row.sign_hash! });
		const gate = gateWith(a, b, c);
		await gate.admit(c.row);
		await gate.admit(b.row);
		expect(gate.stats().pending).toBe(2);
		await gate.admit(a.row);
		expect(gate.stats()).toMatchObject({ admitted: 3, pending: 0 });
	});

	it('T-DAG-05: a message citing its own revision is a violation', async () => {
		const self = makeMessage(alice, {});
		self.refs[self.row.message_id] = self.row.sign_hash!;
		expect(await gateWith(self).admit(self.row)).toMatchObject({ status: 'invalid', reason: 'self_reference' });
	});

	it('citing an older revision of the same message_id is the edit chain, not a self-reference', async () => {
		const genesis = makeMessage(alice, {});
		const edited = makeMessage(bob, { [genesis.row.message_id]: genesis.row.sign_hash! });
		// same message_id as `edited`, different (older) sign_hash in refs
		edited.refs[edited.row.message_id] = 'dms_' + 'a'.repeat(128);
		const gate = gateWith(genesis, edited);
		await gate.admit(genesis.row);
		expect((await gate.admit(edited.row)).status).toBe('waiting'); // older revision unknown → waits, not violates
	});
});

describe('dialog gate — cards and keys as dependencies', () => {
	it('parks a message until its author card verifies, then admits it', async () => {
		const g = makeMessage(alice, {});
		const cards: Record<string, string> = {};
		const gate = makeGate({ cards, refsOf: new Map([[g.row.sign_hash!, {}]]) });

		expect(await gate.admit(g.row)).toMatchObject({ status: 'waiting', missingCard: alice.userHash });

		cards[alice.userHash] = alice.signPkeyB64;
		await gate.onCardVerified(alice.userHash);
		expect(gate.isAdmitted(g.row.message_id, g.row.sign_hash!)).toBe(true);
	});

	// Without the sender's key the causal map is unreadable — that is the
	// normal state right after joining, not an error. Render, don't order.
	it('admits with dagVerified=false when refs cannot be decrypted for lack of a key', async () => {
		const g = makeMessage(alice, {});
		const gate = makeGate({
			cards: { [alice.userHash]: alice.signPkeyB64 },
			refsOf: new Map([[g.row.sign_hash!, 'no_key']]),
		});
		expect(await gate.admit(g.row)).toMatchObject({ status: 'verified', dagVerified: false });
	});

	it('treats an undecryptable refs blob under a valid signature as invalid', async () => {
		const g = makeMessage(alice, {});
		const gate = makeGate({
			cards: { [alice.userHash]: alice.signPkeyB64 },
			refsOf: new Map([[g.row.sign_hash!, 'error']]),
		});
		expect(await gate.admit(g.row)).toMatchObject({ status: 'invalid', reason: 'refs_decrypt_failed' });
	});
});

// The failure this reproduces: cards verified fine straight off the network
// but not after a reload, when persistence hands binary columns back in a
// different encoding. resolveSignPkey then returned null for every author and
// every message parked as "waiting" — including a genesis message, whose refs
// map is empty and which therefore cannot be waiting on anything causal.
describe('dialog gate — exact presented-row identity (reused sign_hash/sign_b64)', () => {
	it('a presentation reusing a prior sign_hash/sign_b64 with a different deleted_flag is re-verified and rejected, not served the cached verified verdict', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		expect(await gate.admit(a.row)).toMatchObject({ status: 'verified', isGenesis: true });

		const c = { ...a.row, deleted_flag: true };
		expect(await gate.admit(c)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	it('a presentation reusing a prior sign_hash/sign_b64 with different content_b64 is re-verified and rejected', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		await gate.admit(a.row);

		const c = { ...a.row, content_b64: toBase64(new Uint8Array([9, 9, 9, 9])) };
		expect(await gate.admit(c)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	it('a presentation reusing a prior sign_hash/sign_b64 with a different refs_map_b64 is re-verified and rejected', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		await gate.admit(a.row);

		const c = { ...a.row, refs_map_b64: toBase64(new Uint8Array([1, 2, 3, 4, 5])) };
		expect(await gate.admit(c)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	it('a presentation reusing a prior sign_hash/sign_b64 with a different owner_timestamp is re-verified and rejected', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		await gate.admit(a.row);

		const c = { ...a.row, owner_timestamp: a.row.owner_timestamp + 1 };
		expect(await gate.admit(c)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	it('a substituted sign_b64 under the same claimed sign_hash (unchanged signed fields) is re-verified and rejected', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		await gate.admit(a.row);

		const foreign = makeMessage(bob, {});
		const c = { ...a.row, sign_b64: foreign.row.sign_b64 };
		expect(await gate.admit(c)).toMatchObject({ status: 'invalid', reason: 'sign_hash_mismatch' });
	});

	it('the originally admitted revision is neither deleted nor overwritten by a rejected same-reference presentation', async () => {
		const a = makeMessage(alice, {});
		const gate = gateWith(a);
		await gate.admit(a.row);

		const c = { ...a.row, deleted_flag: true };
		await gate.admit(c);

		expect(gate.isAdmitted(a.row.message_id, a.row.sign_hash!)).toBe(true);
		expect(gate.isRowAdmitted(a.row)).toBe(true);
		expect(gate.isRowAdmitted(c)).toBe(false);
	});

	it('a rejected same-reference-key presentation never displaces the admitted revision as a DAG dependency', async () => {
		const a = makeMessage(alice, {});
		const child = makeMessage(bob, { [a.row.message_id]: a.row.sign_hash! });
		const gate = gateWith(a, child);
		await gate.admit(a.row);

		const c = { ...a.row, deleted_flag: true };
		await gate.admit(c);

		expect((await gate.admit(child.row)).status).toBe('verified');
	});

	it('concurrent admission of two rows sharing a reference key never lets one borrow the other\'s in-flight verdict', async () => {
		const a = makeMessage(alice, {});
		const c = { ...a.row, deleted_flag: true };
		const gate = gateWith(a);

		const [verdictA, verdictC] = await Promise.all([gate.admit(a.row), gate.admit(c)]);

		expect(verdictA).toMatchObject({ status: 'verified', isGenesis: true });
		expect(verdictC).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
		expect(gate.isAdmitted(a.row.message_id, a.row.sign_hash!)).toBe(true);
	});
});

describe('dialog gate — bounded memory', () => {
	it('regression: a flood of rows blocked on distinct never-arriving refs keeps pending AND blockedOn bounded under a small maxPending', async () => {
		const maxPending = 10;
		const floodCount = maxPending * 6;
		const refsOf = new Map<string, Record<string, string>>();
		const rows: MessageLike[] = [];
		for (let i = 0; i < floodCount; i++) {
			const missingId = `dmsg_missing${i.toString().padStart(6, '0')}`;
			const missingHash = 'dms_' + i.toString(16).padStart(4, '0').repeat(32);
			const m = makeMessage(alice, { [missingId]: missingHash });
			refsOf.set(m.row.sign_hash!, m.refs);
			rows.push(m.row);
		}
		const gate = createDialogGate({
			resolveSignPkey: async (userHash) => (userHash === alice.userHash ? alice.signPkeyB64 : null),
			decryptRefs: async (row) => refsOf.get(row.sign_hash ?? '') ?? {},
			maxPending,
		});

		for (const row of rows) {
			expect((await gate.admit(row)).status).toBe('waiting');
		}

		const stats = gate.stats();
		expect(stats.pending).toBeLessThanOrEqual(maxPending);
		expect(stats.blockedOnRefs).toBeLessThanOrEqual(maxPending);
		expect(stats.blockedOnEdges).toBeLessThanOrEqual(maxPending);
	});

	it('a pending row that survives multiple drain cycles (one dependency landing at a time) keeps blockedOn exactly accurate at every step', async () => {
		const depA = makeMessage(alice, {});
		const depB = makeMessage(alice, { [depA.row.message_id]: depA.row.sign_hash! });
		const depC = makeMessage(alice, { [depA.row.message_id]: depA.row.sign_hash! });
		const child = makeMessage(bob, {
			[depA.row.message_id]: depA.row.sign_hash!,
			[depB.row.message_id]: depB.row.sign_hash!,
			[depC.row.message_id]: depC.row.sign_hash!,
		});
		const gate = gateWith(depA, depB, depC, child);

		expect((await gate.admit(child.row)).status).toBe('waiting');
		expect(gate.stats()).toMatchObject({ pending: 1, blockedOnRefs: 3, blockedOnEdges: 3 });

		await gate.admit(depA.row);
		expect(gate.stats()).toMatchObject({ pending: 1, blockedOnRefs: 2, blockedOnEdges: 2 });

		await gate.admit(depB.row);
		expect(gate.stats()).toMatchObject({ pending: 1, blockedOnRefs: 1, blockedOnEdges: 1 });

		await gate.admit(depC.row);
		expect(gate.isAdmitted(child.row.message_id, child.row.sign_hash!)).toBe(true);
		expect(gate.stats()).toMatchObject({ pending: 0, blockedOnRefs: 0, blockedOnEdges: 0 });
	});

	it('re-submitting the exact same still-pending presentation (the read path re-admits every sync tick) never duplicates its pending entry or reverse edge', async () => {
		const dep = makeMessage(alice, {});
		const child = makeMessage(bob, { [dep.row.message_id]: dep.row.sign_hash! });
		const gate = gateWith(dep, child);

		expect((await gate.admit(child.row)).status).toBe('waiting');
		expect(gate.stats()).toMatchObject({ pending: 1, blockedOnRefs: 1, blockedOnEdges: 1 });

		expect((await gate.admit(child.row)).status).toBe('waiting');
		expect(gate.stats()).toMatchObject({ pending: 1, blockedOnRefs: 1, blockedOnEdges: 1 });
	});

	it('flood of many fingerprints sharing one reference key, with the author card never arriving, keeps awaitingCard bounded', async () => {
		const maxAwaitingCard = 10;
		const floodCount = maxAwaitingCard * 20;
		const base = makeMessage(alice, {});
		const gate = createDialogGate({
			resolveSignPkey: async () => null,
			decryptRefs: async () => ({}),
			maxAwaitingCard,
		});

		for (let i = 0; i < floodCount; i++) {
			const presentation = { ...base.row, content_b64: toBase64(new Uint8Array([i & 0xff, (i >> 8) & 0xff])) };
			expect(await gate.admit(presentation)).toMatchObject({ status: 'waiting', missingCard: alice.userHash });
		}

		expect(gate.stats().awaitingCard).toBeLessThanOrEqual(maxAwaitingCard);
	});

	it('after the author card verifies, parked presentations sharing one reference are checked independently — not all sharing one verdict', async () => {
		const genuine = makeMessage(alice, {});
		const forged = { ...genuine.row, content_b64: toBase64(new Uint8Array([9, 9, 9])) };
		const cards: Record<string, string> = {};
		const gate = makeGate({ cards, refsOf: new Map([[genuine.row.sign_hash!, {}]]) });

		expect(await gate.admit(genuine.row)).toMatchObject({ status: 'waiting', missingCard: alice.userHash });
		expect(await gate.admit(forged)).toMatchObject({ status: 'waiting', missingCard: alice.userHash });

		cards[alice.userHash] = alice.signPkeyB64;
		await gate.onCardVerified(alice.userHash);

		expect(gate.isRowAdmitted(genuine.row)).toBe(true);
		expect(gate.isRowAdmitted(forged)).toBe(false);
		expect(gate.getInvalidReason(forged.message_id, forged.sign_hash!)).toBe('bad_signature');
	});
});

describe('author cards in a different binary encoding', () => {
	const hexOf = (b: Uint8Array) => '\\x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

	it('verifies a card whose binary columns arrived as postgres hex', () => {
		const hexCard = {
			...alice.card,
			sign_pkey: hexOf(alice.sign.publicKey),
			crypt_pkey: hexOf(fromBase64(alice.card.crypt_pkey as string)),
			crypt_cert: hexOf(fromBase64(alice.card.crypt_cert as string)),
			contact_pkey: hexOf(fromBase64(alice.card.contact_pkey as string)),
			contact_cert: hexOf(fromBase64(alice.card.contact_cert as string)),
			sign_b64: hexOf(fromBase64(alice.card.sign_b64 as string)),
		};
		expect(verifyUserCard(hexCard as never).status).toBe('verified');
	});

	it('admits a genesis message when the author card came back as hex', async () => {
		const g = makeMessage(alice, {});
		const verdict = verifyUserCard({
			...alice.card,
			sign_pkey: hexOf(alice.sign.publicKey),
		} as never);
		expect(verdict.status).toBe('verified');
		const gate = makeGate({
			cards: { [alice.userHash]: (verdict as { card: { signPkeyB64: string } }).card.signPkeyB64 },
			refsOf: new Map([[g.row.sign_hash!, {}]]),
		});
		expect(await gate.admit(g.row)).toMatchObject({ status: 'verified', isGenesis: true });
	});
});
