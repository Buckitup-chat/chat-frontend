// Checkpoint lifecycle through the store, on real ML-DSA rows and the real
// gate: creation blocked by incomplete causal history, exact match right
// after signing, and the semantic diff for late arrival / edit / delete —
// with archived revisions coming from the versions collection like on the
// live stack.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { deriveFrontierRoot } from '@/lib/pq/checkpoint';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: 'u_' + '1'.repeat(128) }),
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));
vi.mock('@/lib/data/ingest', () => ({ sendMutationsAndAwaitShape: async () => ({ ok: true }) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => ({}) }) },
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

const makeIdentity = (seed) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactPk = secp.getPublicKey(new Uint8Array(32).fill(seed), true);
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
	return { sign, userHash, card };
};

// The store derives the dialog hash from (me, peer); collections are mocked
// per-test, so the concrete value only has to be self-consistent.
const PEER_SEED = 3;
let author;
let dialogHash;

const makeRow = (mid, tweak = {}) => {
	const fields = {
		message_id: mid,
		dialog_hash: dialogHash,
		sender_hash: author.userHash,
		content_b64: toBase64(new Uint8Array([5, 6, 7])),
		deleted_flag: false,
		refs_map_b64: null,
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
		author = makeIdentity(7);
		peer = makeIdentity(PEER_SEED).userHash;
		collections = {
			cards: makeCollection({ [author.userHash]: author.card }),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer);
	});

	const seed = (...rows) => {
		for (const r of rows) collections.dialog.messages.rows.set(r.message_id, r);
	};

	it('refuses to checkpoint while a row cannot be verified (§7)', async () => {
		const stranger = makeIdentity(9); // card never published
		seed(makeRow(M1), { ...makeRow(M2), sender_hash: stranger.userHash });
		await expect(store.createDialogCheckpoint(peer)).rejects.toThrow('INCOMPLETE_CAUSAL_HISTORY');
	});

	it('creates over verified rows and matches itself immediately', async () => {
		const r1 = makeRow(M1);
		const r2 = makeRow(M2);
		seed(r1, r2);
		const { part } = await store.createDialogCheckpoint(peer);

		expect(part.frontier).toEqual({ [M1]: r1.sign_hash, [M2]: r2.sign_hash });
		expect(part.frontierRoot).toBe(deriveFrontierRoot(part.frontier));

		expect(await store.verifyDialogCheckpoint(peer, part)).toEqual({ status: 'valid' });
		const cmp = await store.compareDialogCheckpoint(peer, part);
		expect(cmp.verdict).toBe('EXACT_MATCH');
		expect(cmp).toMatchObject({ history: { equal: true }, view: { equal: true } });
	});

	it('a late message flips both roots and diffs as exactly MESSAGE_ADDED (§24)', async () => {
		const r1 = makeRow(M1);
		seed(r1);
		const { part } = await store.createDialogCheckpoint(peer);

		seed(makeRow(M2)); // arrives after the checkpoint
		const cmp = await store.compareDialogCheckpoint(peer, part);
		expect(cmp.verdict).toBe('VIEW_CHANGED');
		expect(cmp.history.equal).toBe(false);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.status).toBe('ok');
		expect(diff.changes).toEqual([{ type: 'MESSAGE_ADDED', messageId: M2 }]);
	});

	it('an edit diffs as MESSAGE_EDITED old→new via the versions archive (§25)', async () => {
		const v1 = makeRow(M1);
		seed(v1, makeRow(M3));
		const { part } = await store.createDialogCheckpoint(peer);

		// server-style edit: tip replaced, previous revision archived
		const v2 = makeRow(M1, { content_b64: toBase64(new Uint8Array([8])), parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_600 });
		collections.dialog.messages.rows.set(M1, v2);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.changes).toEqual([
			{ type: 'MESSAGE_EDITED', messageId: M1, oldVersion: v1.sign_hash, newVersion: v2.sign_hash },
		]);
	});

	it('a tombstone diffs as MESSAGE_DELETED (§27)', async () => {
		const v1 = makeRow(M1);
		seed(v1);
		const { part } = await store.createDialogCheckpoint(peer);

		const tomb = makeRow(M1, { content_b64: null, deleted_flag: true, parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_700 });
		collections.dialog.messages.rows.set(M1, tomb);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);

		const diff = await store.diffDialogCheckpoint(peer, part);
		expect(diff.changes).toEqual([
			{ type: 'MESSAGE_DELETED', messageId: M1, oldVersion: v1.sign_hash, newVersion: tomb.sign_hash },
		]);
	});

	it('describeCheckpointDiff hydrates changes with content and authorship', async () => {
		const v1 = makeRow(M1);
		seed(v1);
		const { part } = await store.createDialogCheckpoint(peer);

		// edit M1 and add M2 after the checkpoint
		const v2 = makeRow(M1, { content_b64: toBase64(new Uint8Array([8])), parent_sign_hash: v1.sign_hash, owner_timestamp: 1_700_000_600 });
		collections.dialog.messages.rows.set(M1, v2);
		collections.dialog.versions.rows.set(`${M1}|${v1.sign_hash}`, v1);
		seed(makeRow(M2));

		const diff = await store.describeCheckpointDiff(peer, part);
		expect(diff.status).toBe('ok');
		const edited = diff.changes.find((c) => c.type === 'MESSAGE_EDITED');
		const added = diff.changes.find((c) => c.type === 'MESSAGE_ADDED');
		expect(edited.senderHash).toBe(author.userHash);
		// no dialog keys in this harness — the fallback must say so, not lie
		expect(edited.oldText).toBe('Waiting for keys…');
		expect(edited.newText).toBe('Waiting for keys…');
		expect(added.newText).toBe('Waiting for keys…');
	});

	it('unknown reducer version: signature stands, view unverifiable (§32)', async () => {
		seed(makeRow(M1));
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
		const r1 = makeRow(M1);
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
});
