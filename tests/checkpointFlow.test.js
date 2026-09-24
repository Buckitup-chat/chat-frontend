// Checkpoint lifecycle through the store, on real ML-DSA rows and the real
// gate: creation blocked by incomplete causal history, exact match right
// after signing, and the semantic diff for late arrival / edit / delete —
// with archived revisions coming from the versions collection like on the
// live stack.
//
// Two things keep this harness honest where its predecessor lied:
// - the transport applies mutations (dialogsStore.test.js convention), so
//   the checkpoint's carrier message actually lands and create() cannot
//   claim success for a send that died;
// - rows carry real encrypted refs chains. Refs-less rows all read as empty
//   maps once keys exist, i.e. as competing genesis claims the gate rightly
//   rejects — and tails/closure logic degenerates to "every row is a tail".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { startLeaderElection, stopLeaderElection, enqueue, _setStorageForTests } from '@/lib/data/outbox';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { _setStoreForTests } from '@/lib/data/localStore';
import { loadPointer } from '@/lib/data/checkpointAlerts';
import { deriveFrontierRoot, CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION } from '@/lib/pq/checkpoint';
import { decodeContent } from '@/lib/pq/content';
import { recoverIntents } from '@/lib/data/intentRecovery';
import { materializeMessageIntent } from '@/lib/data/messageIntent';
import { intentsOf, getIntent } from '@/lib/data/intents';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections;
let sendImpl;

const HOLDER = vi.hoisted(() => ({ user: null, vault: {}, vaultLocked: false }));

vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	// Reactive so the store's account-switch watcher sees the change like it
	// does on the live Pinia store.
	HOLDER.user = reactive({ currentUserHash: '' });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (h, read) => read(collections.dialog),
}));
const { MockDurabilityError } = vi.hoisted(() => {
	class MockDurabilityError extends Error {}
	return { MockDurabilityError };
});
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (mutations) => {
		const result = await sendImpl(mutations);
		return { outboxId: 'test-outbox-id', phase: 'accepted', result, acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
	DurabilityError: MockDurabilityError,
	OWNER_FIELD: {
		dialog_keys: 'sender_hash',
		dialog_messages: 'sender_hash',
		dialog_message_reactions: 'reactor_hash',
		dialog_message_receipts: 'peer_hash',
	},
}));
vi.mock('@/lib/data/intents', () => {
	const store = new Map();
	let seq = 0;
	return {
		onIntentChange: () => () => {},
		enqueueIntent: async (intent, userHash, relation) => {
			const id = `test-intent-${seq++}`;
			store.set(id, { id, userHash, relation, intent });
			return id;
		},
		updateIntent: async (id, intent) => {
			const existing = store.get(id);
			if (!existing) return false;
			store.set(id, { ...existing, intent });
			return true;
		},
		resolveIntent: async () => true,
		getIntent: async (id) => store.get(id) ?? null,
		intentsOf: async (userHash) => ({ entries: [...store.values()].filter((e) => e.userHash === userHash), issues: [] }),
	};
});
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => {
				if (HOLDER.vaultLocked) throw new Error('vault is locked');
				return HOLDER.vault;
			},
		}),
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

const makeIdentity = (seed) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash,
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `sender-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card, sign.secretKey);
	return {
		sign, kem, contactSk, userHash, card,
		vault: {
			sign_skey: toBase64(sign.secretKey),
			crypt_skey: toBase64(kem.secretKey),
			evm_skey: bytesToHex(contactSk),
		},
	};
};

// The fake server: a write is readable through the collection once the send
// resolves (the real path only resolves after the shape barrier).
const PRIMARY_KEY = {
	dialog_keys: (r) => `${r.dialog_hash}|${r.sender_hash}`,
	dialog_messages: (r) => r.message_id,
};
const COLLECTION_FOR = {
	dialog_keys: () => collections.dialog.keys,
	dialog_messages: () => collections.dialog.messages,
};
const applyMutation = (m) => {
	const relation = m.syncMetadata?.relation;
	const row = m.modified ?? m.changes;
	const pk = PRIMARY_KEY[relation];
	const coll = COLLECTION_FOR[relation]?.();
	if (!pk || !coll) return;
	const key = pk(row);
	coll.rows.set(key, { ...coll.rows.get(key), ...row });
};

let author;
let dialogHash;
let senderKey;

// refs: {message_id: sign_hash} plaintext, or null for a row whose blob the
// harness deliberately leaves absent (undecryptable-refs branch).
const makeRow = async (mid, refs, tweak = {}) => {
	const fields = {
		message_id: mid,
		dialog_hash: dialogHash,
		sender_hash: author.userHash,
		content_b64: toBase64(new Uint8Array([5, 6, 7])),
		deleted_flag: false,
		refs_map_b64: refs === null ? null : await DialogCrypto.encryptContent(senderKey, JSON.stringify(refs)),
		parent_sign_hash: null,
		owner_timestamp: 1_700_000_500,
		...tweak,
	};
	const sign_b64 = signFields(fields, author.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
};

const M1 = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const M2 = 'dmsg_0192aaaa-0000-7000-8000-000000000002';
const M3 = 'dmsg_0192aaaa-0000-7000-8000-000000000003';

describe('checkpoint through the store', () => {
	let store;
	let peer;

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		HOLDER.vaultLocked = false;
		const mem = new Map();
		_setStoreForTests({
			async get(k) { return mem.get(k) ?? null; },
			async set(k, v) { mem.set(k, v); },
			async delete(k) { mem.delete(k); },
			async keys() { return [...mem.keys()]; },
			async clear() { mem.clear(); },
		});
		author = makeIdentity(7);
		const peerId = makeIdentity(3);
		peer = peerId.userHash;
		HOLDER.user.currentUserHash = author.userHash;
		HOLDER.vault = author.vault;
		stopLeaderElection();
		startLeaderElection(author.userHash, () => {});
		_setProjectionStorageForTests((() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, keys: async () => [...m.keys()], clear: async () => { m.clear(); } }; })());
		_setOwnObservedTailsStorageForTests({
			_map: new Map(),
			async get(k) { return this._map.get(k) ?? null; },
			async set(k, v) { this._map.set(k, v); },
			async delete(k) { this._map.delete(k); },
			async keys() { return [...this._map.keys()]; },
			async clear() { this._map.clear(); },
		});
		_setStorageForTests({
			_map: new Map(),
			async get(k) { return this._map.get(k) ?? null; },
			async set(k, v) { this._map.set(k, v); },
			async delete(k) { this._map.delete(k); },
			async keys() { return [...this._map.keys()]; },
			async clear() { this._map.clear(); },
		});
		collections = {
			cards: makeCollection({ [author.userHash]: author.card, [peer]: peerId.card }),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		sendImpl = async (mutations) => {
			mutations.forEach(applyMutation);
			return { txids: [] };
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer);
		// The author's dialog key exists before any message — the backend
		// enforces exactly this order (check_dialog_key_published).
		collections.dialog.keys.rows.set(`${dialogHash}|${author.userHash}`, {
			dialog_hash: dialogHash, sender_hash: author.userHash, peer_hash: peer, deleted_flag: false,
		});
		senderKey = DialogCrypto.deriveSenderMsgKey(
			author.sign.secretKey, author.kem.secretKey, bytesToHex(author.contactSk), peer,
		);
	});

	const seed = (...rows) => {
		for (const r of rows) collections.dialog.messages.rows.set(r.message_id, r);
	};

	// Simulate "the carrier has not replicated back yet" for the diff-semantics
	// tests, which reason about the attested set alone.
	const unreplicate = (messageId) => collections.dialog.messages.rows.delete(messageId);

	it('refuses to checkpoint while a row cannot be verified (§7)', async () => {
		const r1 = await makeRow(M1, {});
		const stranger = makeIdentity(9); // card never published
		const foreign = { ...(await makeRow(M2, { [M1]: r1.sign_hash })), sender_hash: stranger.userHash };
		seed(r1, foreign);
		await expect(store.createDialogCheckpoint(peer)).rejects.toThrow('INCOMPLETE_CAUSAL_HISTORY');
	});

	it('refuses to checkpoint while any refs blob is undecryptable', async () => {
		const r1 = await makeRow(M1, {});
		// a blob is present but the harness encrypted it under a different key
		const opaque = await makeRow(M2, null, {
			refs_map_b64: await DialogCrypto.encryptContent(new Uint8Array(32).fill(1), '{}'),
		});
		seed(r1, opaque);
		await expect(store.createDialogCheckpoint(peer)).rejects.toThrow('INCOMPLETE_CAUSAL_HISTORY');
	});

	it('creates over verified rows and matches itself immediately', async () => {
		const r1 = await makeRow(M1, {});
		const r2 = await makeRow(M2, { [M1]: r1.sign_hash });
		seed(r1, r2);
		const { part, messageId } = await store.createDialogCheckpoint(peer);

		// transitive reduction: M2 covers M1, so the frontier is M2 alone
		expect(part.frontier).toEqual({ [M2]: r2.sign_hash });
		expect(part.frontierRoot).toBe(deriveFrontierRoot(part.frontier));

		// the carrier row replicated (honest transport); comparison scoped to
		// the pointer must still be an exact match
		expect(collections.dialog.messages.rows.has(messageId)).toBe(true);
		expect(await store.verifyDialogCheckpoint(peer, part)).toEqual({ status: 'valid' });
		const cmp = await store.compareDialogCheckpoint(peer, part, { pointerMessageId: messageId });
		expect(cmp.verdict).toBe('EXACT_MATCH');
		expect(cmp).toMatchObject({ history: { equal: true }, view: { equal: true } });
	});

	// A checkpoint that never left the device must not claim it protects
	// anything: no success, no cleared alert, no pointer past the ghost row.
	it('a failed send surfaces as an error and clears nothing', async () => {
		seed(await makeRow(M1, {}));
		// shaped like a transient IngestError: durable in the outbox, retried
		const transient = Object.assign(new Error('ingest network error'), { name: 'IngestError', permanent: false });
		sendImpl = async () => { throw transient; };
		const failure = await store.createDialogCheckpoint(peer).then(() => null, (e) => e);
		expect(failure?.message).toBe('CHECKPOINT_SEND_FAILED');
		// the cause travels so the UI can say "queued, will retry" instead of
		// reporting an outbox-held write as lost
		expect(failure?.cause).toBe(transient);
		expect(store.checkpointAlerts.has(peer)).toBe(false);
	});

	it('a late message flips both roots and diffs as exactly MESSAGE_ADDED (§24)', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		unreplicate(messageId);

		seed(await makeRow(M2, { [M1]: r1.sign_hash })); // arrives after the checkpoint
		const cmp = await store.compareDialogCheckpoint(peer, part);
		expect(cmp.verdict).toBe('VIEW_CHANGED');
		expect(cmp.history.equal).toBe(false);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.status).toBe('ok');
		expect(diff.changes).toEqual([{ type: 'MESSAGE_ADDED', messageId: M2 }]);
	});

	it('an edit diffs as MESSAGE_EDITED old→new via the versions archive (§25)', async () => {
		const v1 = await makeRow(M1, {});
		const r3 = await makeRow(M3, { [M1]: v1.sign_hash });
		seed(v1, r3);
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		unreplicate(messageId);

		// server-style edit: tip replaced, previous revision archived; the new
		// revision's refs are the viewport tails at edit time
		const v2 = await makeRow(M1, { [M3]: r3.sign_hash }, {
			content_b64: toBase64(new Uint8Array([8])), parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_600,
		});
		collections.dialog.messages.rows.set(M1, v2);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.changes).toEqual([
			{ type: 'MESSAGE_EDITED', messageId: M1, oldVersion: v1.sign_hash, newVersion: v2.sign_hash },
		]);
	});

	it('a tombstone diffs as MESSAGE_DELETED (§27)', async () => {
		const v1 = await makeRow(M1, {});
		seed(v1);
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		unreplicate(messageId);

		const tomb = await makeRow(M1, { [M1]: v1.sign_hash }, {
			content_b64: null, deleted_flag: true, parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_700,
		});
		collections.dialog.messages.rows.set(M1, tomb);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.changes).toEqual([
			{ type: 'MESSAGE_DELETED', messageId: M1, oldVersion: v1.sign_hash, newVersion: tomb.sign_hash },
		]);
	});

	// pq_dialogs.md §Tail calculation: deleted messages participate — the
	// tombstone is a signed revision like any edit, so its pair enters the
	// tail set and the fact of deletion propagates causally. The frontier
	// follows the same rule, or the roots skew on identical state.
	it('the frontier follows the refs_map tail rule: tombstones stay in', async () => {
		const r1 = await makeRow(M1, {});
		const tomb = await makeRow(M2, { [M1]: r1.sign_hash }, {
			content_b64: null, deleted_flag: true, owner_timestamp: 1_700_000_700,
		});
		seed(r1, tomb);
		const { part } = await store.createDialogCheckpoint(peer);
		// The tombstone covers M1 through its refs, so it is the sole tail.
		// This candidate rule is part of what a signed frontierRoot means
		// (hedged ML-DSA makes the root itself unpinnable): changing which
		// rows enter this map requires a CHECKPOINT_VERSION bump (v3 =
		// tombstones in), or old roots read as "history changed" on
		// identical state.
		expect(part.frontier).toEqual({ [M2]: tomb.sign_hash });
	});

	it('describeCheckpointDiff hydrates changes with content and authorship', async () => {
		const v1 = await makeRow(M1, {});
		seed(v1);
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		unreplicate(messageId);

		// edit M1 and add M2 after the checkpoint
		const v2 = await makeRow(M1, { [M1]: v1.sign_hash }, {
			content_b64: toBase64(new Uint8Array([8])), parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_600,
		});
		collections.dialog.messages.rows.set(M1, v2);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);
		seed(await makeRow(M2, { [M1]: v2.sign_hash }));

		const diff = await store.describeCheckpointDiff(peer, part);
		expect(diff.status).toBe('ok');
		const edited = diff.changes.find((c) => c.type === 'MESSAGE_EDITED');
		const added = diff.changes.find((c) => c.type === 'MESSAGE_ADDED');
		expect(edited.senderHash).toBe(author.userHash);
		// the harness rows carry junk ciphertext — the preview must say so,
		// not render junk as the revision's words
		expect(edited.oldText).toBe('Undecryptable content');
		expect(edited.newText).toBe('Undecryptable content');
		expect(added.newText).toBe('Undecryptable content');
	});

	// The pointer splits the feed: attested history behind it is bounded and
	// detailed; the continuation ahead is unbounded and collapses to a count.
	it('details only the past; future messages collapse into one marker', async () => {
		const LATE = 'dmsg_0192aa00-0000-7000-8000-00000000000a'; // authored before the pointer
		const CP = 'dmsg_0192aaab-0000-7000-8000-00000000000b'; // the checkpoint message itself
		const F1 = 'dmsg_0192aaac-0000-7000-8000-00000000000c';
		const F2 = 'dmsg_0192aaad-0000-7000-8000-00000000000d';

		const v1 = await makeRow(M1, {});
		seed(v1);
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		unreplicate(messageId);

		// afterwards: an edit of attested history, a LATE old message slotting
		// in behind the pointer, the checkpoint's own row, and two new ones
		const v2 = await makeRow(M1, { [M1]: v1.sign_hash }, {
			content_b64: toBase64(new Uint8Array([8])), parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_600,
		});
		collections.dialog.messages.rows.set(M1, v2);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);
		const late = await makeRow(LATE, { [M1]: v1.sign_hash });
		const cp = await makeRow(CP, { [M1]: v2.sign_hash });
		const f1 = await makeRow(F1, { [CP]: cp.sign_hash });
		const f2 = await makeRow(F2, { [F1]: f1.sign_hash });
		seed(late, cp, f1, f2);

		const diff = await store.describeCheckpointDiff(peer, part, { pointerMessageId: CP });
		expect(diff.status).toBe('ok');
		expect(diff.changes.map((c) => [c.type, c.messageId]).sort()).toEqual([
			['MESSAGE_ADDED', LATE],
			['MESSAGE_EDITED', M1],
		]);
		expect(diff.futureAdded).toEqual({ count: 2, firstMessageId: F1 });
	});

	it('unknown reducer version: signature stands, view unverifiable (§32)', async () => {
		seed(await makeRow(M1, {}));
		const { part } = await store.createDialogCheckpoint(peer);
		const foreign = { ...part, reducerVersion: 'dialog-state-v99' };

		expect(await store.verifyDialogCheckpoint(peer, foreign)).toEqual({
			status: 'unsupported_version', component: 'reducer_version', version: 'dialog-state-v99',
		});
		const cmp = await store.compareDialogCheckpoint(peer, foreign);
		expect(cmp.verdict).toBe('VIEW_UNVERIFIABLE');
		expect(cmp.view.equal).toBe(null);
	});

	it('a tampered frontier_root is INVALID; unknown revisions are incomplete history', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		const { part } = await store.createDialogCheckpoint(peer);

		expect((await store.verifyDialogCheckpoint(peer, { ...part, frontierRoot: 'dfr_' + '0'.repeat(128) })).status)
			.toBe('invalid');

		const ghost = { [M2]: 'dms_' + 'f'.repeat(128) };
		const foreign = { ...part, frontier: ghost, frontierRoot: deriveFrontierRoot(ghost) };
		expect(await store.verifyDialogCheckpoint(peer, foreign)).toEqual({
			status: 'incomplete_history', missingEventIds: [`${M2}|dms_${'f'.repeat(128)}`],
		});
		expect((await store.diffDialogCheckpoint(peer, foreign)).status).toBe('incomplete_history');
	});

	// sign_hash is a derived column not covered by the signature. A planted
	// row whose column lies about its sign_b64 must not turn a frontier
	// reference to that invented hash into "known history".
	it('a row with a forged sign_hash column does not make the frontier valid', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		const forgedHash = 'dms_' + 'e'.repeat(128);
		seed({ ...(await makeRow(M2, { [M1]: r1.sign_hash })), sign_hash: forgedHash });

		const frontier = { [M1]: r1.sign_hash, [M2]: forgedHash };
		const part = {
			kind: 'checkpoint',
			version: CHECKPOINT_VERSION,
			reducerVersion: REDUCER_VERSION,
			treeVersion: TREE_VERSION,
			frontierRoot: deriveFrontierRoot(frontier),
			viewRoot: 'dvr_' + '0'.repeat(128),
			frontier,
			createdAt: 1_700_000_800,
		};
		const verdict = await store.verifyDialogCheckpoint(peer, part);
		expect(verdict.status).toBe('incomplete_history');
		expect(verdict.missingEventIds).toEqual([`${M2}|${forgedHash}`]);
	});

	// On the live stack the checkpoint's carrier message replicates like any
	// row. Without excluding it, a checkpoint disagrees with itself the moment
	// its own message lands: an extra view leaf and a new frontier tail.
	it('a checkpoint still matches itself after its carrier replicates', async () => {
		seed(await makeRow(M1, {}));
		const { part, messageId } = await store.createDialogCheckpoint(peer);

		const withoutPointer = await store.compareDialogCheckpoint(peer, part);
		expect(withoutPointer.verdict).not.toBe('EXACT_MATCH'); // the trap, documented

		const cmp = await store.compareDialogCheckpoint(peer, part, { pointerMessageId: messageId });
		expect(cmp.verdict).toBe('EXACT_MATCH');
		expect(cmp).toMatchObject({ history: { equal: true }, view: { equal: true } });
	});

	// The send can take minutes; an account switch inside that window must
	// not write A's checkpoint pointer under B's keys — B would inherit an
	// unquenchable dot for a carrier that does not exist in B's dialog.
	it('an account switch during the send leaves the new account untouched', async () => {
		seed(await makeRow(M1, {}));
		const other = makeIdentity(21);
		sendImpl = async (mutations) => {
			mutations.forEach(applyMutation);
			HOLDER.user.currentUserHash = other.userHash; // switch mid-flight
			return { txids: [] };
		};
		await store.createDialogCheckpoint(peer);
		expect(store.checkpointAlerts.size).toBe(0); // nothing planted for B
		const dialogHashB = store.getDialogHash(peer); // derived under B now
		const pointerB = await loadPointer(other.userHash, dialogHashB);
		expect(pointerB.checkpoint).toBe(null);
	});

	// Version gates guard every protocol entry, not only verify: comparing
	// or diffing under foreign semantics must say "unverifiable", never
	// fabricate INCONSISTENT_VIEW from incomparable roots.
	it('foreign semantics are unverifiable in compare and unsupported in diff', async () => {
		seed(await makeRow(M1, {}));
		const { part, messageId } = await store.createDialogCheckpoint(peer);
		const foreign = { ...part, version: 1 };
		const cmp = await store.compareDialogCheckpoint(peer, foreign, { pointerMessageId: messageId });
		expect(cmp.verdict).toBe('VIEW_UNVERIFIABLE');
		expect(cmp.view.equal).toBe(null);
		const diff = await store.diffDialogCheckpoint(peer, { ...part, treeVersion: 'dialog-view-tree-v99' });
		expect(diff.status).toBe('unsupported_version');
	});

	// A peer signs whatever message_id they like and the gate does not
	// constrain the field; the hostile row must surface as unadmitted at
	// the reducer boundary, not as a TypeError from the trie — the
	// unadmitted throw fires before the frontier tripwire would see it.
	it('a tombstone with an out-of-grammar id blocks signing, without throwing', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		// signed BY the peer's key over the hostile id — the gate verifies
		// the signature, but the id never entered this store's view state
		const hostile = await makeRow('dmsg_ключ', { [M1]: r1.sign_hash }, {
			content_b64: null, deleted_flag: true,
		});
		seed(hostile);
		const failure = await store.createDialogCheckpoint(peer).then(() => null, (e) => e);
		expect(failure?.message).toBe('INCOMPLETE_CAUSAL_HISTORY');
		expect(failure?.details.unadmitted).toContain('dmsg_ключ');
	});

	// Session caches are keyed by dialog/peer, not account: a peer present in
	// two accounts' lists must not inherit account A's alert dot under B.
	it('an account switch clears the alert map', async () => {
		seed(await makeRow(M1, {}));
		await store.createDialogCheckpoint(peer);
		expect(store.checkpointAlerts.has(peer)).toBe(true);

		HOLDER.user.currentUserHash = makeIdentity(21).userHash;
		await new Promise((r) => setTimeout(r, 0));
		expect(store.checkpointAlerts.size).toBe(0);
	});

	it('checkpoint captured scope: frozen at creation, covers an own signed-but-not-accepted message, and never waits on its SERVER_ACCEPTED (main-tanstack-proposal-v3.md §323,441,712)', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		await store.admitMessageRow(r1);

		const OWN_PENDING_ID = 'dmsg_0192aaaa-0000-7000-8000-0000000000aa';
		const rowOf = (m) => m.modified ?? m.changes;
		const sent = [];
		const unsettled = [];

		sendImpl = async (mutations) => {
			await enqueue(mutations, author.userHash);
			sent.push(...mutations);
			return new Promise((resolve) => unsettled.push({ id: rowOf(mutations[0])?.message_id, resolve }));
		};

		const waitFor = async (predicate, label) => {
			for (let i = 0; i < 200; i++) {
				if (predicate()) return;
				await Promise.resolve();
				await new Promise((r) => setTimeout(r, 0));
			}
			throw new Error(`timed out waiting for: ${label}`);
		};

		try {
			store.sendMessage(peer, 'own pending', () => {}, OWN_PENDING_ID);
			await waitFor(
				() => sent.some((m) => rowOf(m)?.message_id === OWN_PENDING_ID),
				'own pending message to be signed and outbox-durable'
			);
			const ownPendingSignHash = rowOf(sent.find((m) => rowOf(m)?.message_id === OWN_PENDING_ID)).sign_hash;

			let result;
			const checkpointPromise = store.createDialogCheckpoint(peer).then((r) => { result = r; });
			await waitFor(
				() => sent.some((m) => rowOf(m)?.message_id && rowOf(m).message_id !== OWN_PENDING_ID),
				'checkpoint carrier to be signed and outbox-durable'
			);

			seed(await makeRow(M2, { [M1]: r1.sign_hash }));

			unsettled.find((u) => u.id !== OWN_PENDING_ID).resolve({ txids: [] });
			await checkpointPromise;

			const { part, messageId } = result;
			expect(part.frontier).toEqual({ [M1]: r1.sign_hash });

			const carrierRow = rowOf(sent.find((m) => rowOf(m)?.message_id === messageId));
			const refs = JSON.parse(await DialogCrypto.decryptContent(senderKey, carrierRow.refs_map_b64));
			expect(refs).toEqual({ [OWN_PENDING_ID]: ownPendingSignHash });
		} finally {
			unsettled.forEach((u) => u.resolve({ txids: [] }));
			await new Promise((r) => setTimeout(r, 0));
		}
	});

	it('checkpoint captured scope survives AWAITING_UNLOCK -> real intent recovery: a tail admitted during the wait is not retroactively added, and recovery reuses the same intent (main-tanstack-proposal-v3.md §427,439,708,712)', async () => {
		const r1 = await makeRow(M1, {});
		seed(r1);
		await store.admitMessageRow(r1);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sent = [];
		sendImpl = async (mutations) => {
			mutations.forEach(applyMutation);
			sent.push(...mutations);
			return { txids: [] };
		};
		const rowOf = (m) => m.modified ?? m.changes;

		const waitFor = async (predicate, label) => {
			for (let i = 0; i < 200; i++) {
				if (await predicate()) return;
				await new Promise((r) => setTimeout(r, 0));
			}
			throw new Error(`timed out waiting for: ${label}`);
		};

		HOLDER.vaultLocked = true;
		try {
			void store.createDialogCheckpoint(peer);

			const isThisCheckpoint = (e) => e.relation === 'dialog_messages' && e.intent?.kind === 'checkpoint';
			await waitFor(async () => {
				const { entries } = await intentsOf(author.userHash);
				return entries.some(isThisCheckpoint);
			}, 'checkpoint intent to be durably captured');

			const { entries: capturedEntries } = await intentsOf(author.userHash);
			const capturedCheckpointEntries = capturedEntries.filter(isThisCheckpoint);
			expect(capturedCheckpointEntries).toHaveLength(1);
			const checkpointEntry = capturedCheckpointEntries[0];
			const intentId = checkpointEntry.id;
			const capturedMessageId = checkpointEntry.intent.messageId;
			const capturedObservedTails = checkpointEntry.intent.observedTails;
			const capturedFrontier = checkpointEntry.intent.parts[0].frontier;
			expect(capturedFrontier).toEqual({ [M1]: r1.sign_hash });

			await waitFor(
				() => warnSpy.mock.calls.some((c) => String(c[0]).includes('dispatchMessageIntent awaiting unlock')),
				'dispatch to report awaiting_unlock'
			);
			expect(sent).toHaveLength(0);

			const r2 = await makeRow(M2, { [M1]: r1.sign_hash });
			seed(r2);
			await store.admitMessageRow(r2);

			setActivePinia(createPinia());
			store = useDialogsStore();

			HOLDER.vaultLocked = false;
			await recoverIntents(author.userHash, author.sign.secretKey, {
				materializeMessage: materializeMessageIntent,
			});

			const idsAtCapture = new Set(capturedEntries.map((e) => e.id));
			const { entries: afterEntries } = await intentsOf(author.userHash);
			expect(afterEntries.filter((e) => !idsAtCapture.has(e.id))).toHaveLength(0);
			expect(afterEntries.some((e) => e.id === intentId)).toBe(true);
			const recovered = await getIntent(intentId);
			expect(recovered.intent.signedMutation).toBeTruthy();

			const carrierMutation = sent.find((m) => rowOf(m)?.message_id === capturedMessageId);
			expect(carrierMutation).toBeTruthy();
			const carrierRow = rowOf(carrierMutation);

			const refs = JSON.parse(await DialogCrypto.decryptContent(senderKey, carrierRow.refs_map_b64));
			expect(refs).toEqual(capturedObservedTails);
			expect(refs).not.toHaveProperty(M2);

			const [signedPart] = decodeContent(await DialogCrypto.decryptContent(senderKey, carrierRow.content_b64));
			expect(signedPart.frontier).toEqual(capturedFrontier);
			expect(signedPart.frontier).not.toHaveProperty(M2);
		} finally {
			HOLDER.vaultLocked = false;
			warnSpy.mockRestore();
		}
	});
});
