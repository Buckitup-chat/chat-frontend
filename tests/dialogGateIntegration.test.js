// The gate wired through the store: a replicated row reaches "message" status
// only by verifying against its author's replicated card — with real ML-DSA
// signatures on both, and the card registry reading the same collection mock
// the rest of the data layer uses.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';

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

const DIALOG = 'di_' + 'a'.repeat(128);

const makeRow = (author, tweak = {}) => {
	const fields = {
		message_id: `dmsg_${Math.random().toString(16).slice(2)}`,
		dialog_hash: DIALOG,
		sender_hash: author.userHash,
		content_b64: toBase64(new Uint8Array([5, 6, 7])),
		deleted_flag: false,
		refs_map_b64: null,
		parent_sign_hash: null,
		owner_timestamp: 1_700_000_500,
	};
	const sign_b64 = signFields(fields, author.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64), ...tweak };
};

describe('gate through the store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		resetCardRegistry();
		collections = {
			cards: makeCollection(),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
	});

	it('verifies an honest row against the author card from the collection', async () => {
		const author = makeIdentity(3);
		collections.cards.rows.set(author.userHash, author.card);
		const store = useDialogsStore();
		// no dialog key for this author yet → refs unreadable → dagVerified=false
		const verdict = await store.admitMessageRow(makeRow(author));
		expect(verdict).toMatchObject({ status: 'verified', dagVerified: false });
	});

	it('rejects a row whose content was swapped after signing', async () => {
		const author = makeIdentity(4);
		collections.cards.rows.set(author.userHash, author.card);
		const store = useDialogsStore();
		const verdict = await store.admitMessageRow(makeRow(author, { content_b64: toBase64(new Uint8Array([9])) }));
		expect(verdict).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
	});

	// The forged-card case end to end: right key math, wrong identity claim.
	it('does not verify a row whose author card is itself forged', async () => {
		const author = makeIdentity(5);
		const other = makeIdentity(6);
		// a card claiming the author's hash but carrying another sign_pkey
		collections.cards.rows.set(author.userHash, { ...other.card, user_hash: author.userHash });
		const store = useDialogsStore();
		const verdict = await store.admitMessageRow(makeRow(author));
		expect(verdict).toMatchObject({ status: 'waiting', missingCard: author.userHash });
	});

	it('re-admits a parked row when the author card lands', async () => {
		const author = makeIdentity(7);
		const store = useDialogsStore();
		const row = makeRow(author);

		expect(await store.admitMessageRow(row)).toMatchObject({ status: 'waiting', missingCard: author.userHash });

		collections.cards.rows.set(author.userHash, author.card);
		await store.retryCardAdmissions();
		// parked row was re-admitted by the retry; a direct admit now confirms
		expect(await store.admitMessageRow(row)).toMatchObject({ status: 'verified' });
	});
});

describe('side rows through the store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		resetCardRegistry();
		collections = {
			cards: makeCollection(),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
	});

	const makeReaction = (author, tweak = {}) => {
		const fields = {
			reaction_hash: 'dmr_' + 'b'.repeat(128),
			dialog_hash: DIALOG,
			message_id: 'dmsg_feed',
			message_sign_hash: 'dms_' + 'c'.repeat(128),
			reactor_hash: author.userHash,
			type_b64: toBase64(new Uint8Array([1])),
			deleted_flag: false,
			owner_timestamp: 1_700_000_600,
		};
		return { ...fields, sign_b64: signFields(fields, author.sign.secretKey), ...tweak };
	};

	it('admits an honestly signed reaction', async () => {
		const author = makeIdentity(8);
		collections.cards.rows.set(author.userHash, author.card);
		const store = useDialogsStore();
		expect(await store.admitReactionRow(makeReaction(author))).toBe(true);
	});

	// A forged reaction under a peer's name is the same attack class as a
	// forged message — an attacker "agreeing" on the victim's behalf.
	it('rejects a reaction whose emoji ciphertext was swapped after signing', async () => {
		const author = makeIdentity(9);
		collections.cards.rows.set(author.userHash, author.card);
		const store = useDialogsStore();
		const forged = makeReaction(author, { type_b64: toBase64(new Uint8Array([9, 9])) });
		expect(await store.admitReactionRow(forged)).toBe(false);
	});

	it('does not admit a reaction while the reactor card is absent', async () => {
		const author = makeIdentity(10);
		const store = useDialogsStore();
		expect(await store.admitReactionRow(makeReaction(author))).toBe(false);
	});
});

describe('version history through the store (§3.1)', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		resetCardRegistry();
		collections = {
			cards: makeCollection(),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
	});

	const makeVersion = (author, tweak = {}) => {
		const fields = {
			message_id: 'dmsg_hist',
			dialog_hash: DIALOG,
			sender_hash: author.userHash,
			content_b64: toBase64(new Uint8Array([1, 2])),
			deleted_flag: false,
			refs_map_b64: null,
			parent_sign_hash: null,
			owner_timestamp: 1_700_000_100,
		};
		const sign_b64 = signFields(fields, author.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64), ...tweak };
	};

	it('verifies each archived revision against the author card', async () => {
		const author = makeIdentity(11);
		collections.cards.rows.set(author.userHash, author.card);
		collections.dialog.versions.rows.set('v1', makeVersion(author));
		const store = useDialogsStore();

		const history = await store.getMessageHistory(DIALOG, 'dmsg_hist');
		expect(history).toHaveLength(1);
		expect(history[0].verified).toBe(true);
		// no dialog key in the mock → content honestly pending, not fabricated
		expect(history[0].text).toMatch(/Waiting for keys/);
	});

	// A forged "old version" planted in the feed is the perfect place to put
	// words in someone's mouth — it must surface as unverifiable, not render.
	it('marks a tampered revision as unverifiable instead of showing its text', async () => {
		const author = makeIdentity(12);
		collections.cards.rows.set(author.userHash, author.card);
		collections.dialog.versions.rows.set('v1',
			makeVersion(author, { content_b64: toBase64(new Uint8Array([9, 9, 9])) }));
		const store = useDialogsStore();

		const history = await store.getMessageHistory(DIALOG, 'dmsg_hist');
		expect(history[0].verified).toBe(false);
		expect(history[0].text).toBe('Unverifiable revision');
	});

	it('orders revisions newest first and filters by message', async () => {
		const author = makeIdentity(13);
		collections.cards.rows.set(author.userHash, author.card);
		collections.dialog.versions.rows.set('a', makeVersion(author, { owner_timestamp: 100 }));
		collections.dialog.versions.rows.set('b', makeVersion(author, { owner_timestamp: 200 }));
		collections.dialog.versions.rows.set('other', makeVersion(author, { message_id: 'dmsg_other' }));
		const store = useDialogsStore();

		const history = await store.getMessageHistory(DIALOG, 'dmsg_hist');
		expect(history.map((h) => h.ownerTimestamp)).toEqual([200, 100]);
	});
});
