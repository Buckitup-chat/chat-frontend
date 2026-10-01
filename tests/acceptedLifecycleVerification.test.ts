import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const http = { bodies: [] as string[] };
vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			http.bodies.push(JSON.stringify(mutations));
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 700 + index })) }) } as unknown as Response;
		},
	},
}));
const barrier = { visible: true, calls: 0 };
vi.mock('@/lib/data/barrier', () => ({
	awaitShapeVisibility: async () => { barrier.calls++; return barrier.visible; },
	collectionForRelation: () => null,
	scopeForRelation: (relation: string) => relation,
}));
vi.mock('@/lib/data/writeContracts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/data/writeContracts')>()),
	contractFor: () => ({ dependencyClass: 'independent', confirmation: 'visible' }),
}));

const { VaultLockedError, AccountMismatchError } = await import('@/lib/data/keyCustody');
const { createSecureStore } = await import('@/lib/data/secureStore');
const { verifyReplicatedRow, verifyRowWithKey } = await import('@/lib/data/rowVerification');
const { observeAcceptedOperation, verifyAcceptedOperation, readAcceptedOperation } = await import('@/lib/data/operationLifecycle');
const acceptedSnapshot = await import('@/lib/data/acceptedSnapshot');
const ingest = await import('@/lib/data/ingest');
const outbox = await import('@/lib/data/outbox');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { mirrorDialogTable, readDialogRows } = await import('@/lib/data/dialogCache');

type Row = Record<string, unknown>;

const makeIdentity = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactPk = secp.getPublicKey(new Uint8Array(32).fill(seed), true);
	const card: Row = {
		user_hash: 'u_' + bytesToHex(sha3_512(sign.publicKey)),
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `user-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return { sign, userHash: card.user_hash as string, card };
};
const alice = makeIdentity(11);
const bob = makeIdentity(12);
const DIALOG = 'di_' + 'd'.repeat(128);

const resolverFor = (...cards: Row[]) => async (userHash: string) => {
	const card = cards.find((c) => c.user_hash === userHash);
	if (!card || (await verifyReplicatedRow('user_cards', card, async () => null)).status !== 'verified') return null;
	return card.sign_pkey as string;
};
const resolve = resolverFor(alice.card, bob.card);

const signed = (author: typeof alice, fields: Row, signHashPrefix?: string): Row => {
	const sign_b64 = signFields(fields as never, author.sign.secretKey);
	return { ...fields, sign_b64, ...(signHashPrefix ? { sign_hash: deriveSignHash(signHashPrefix, sign_b64) } : {}) };
};
const message = (author: typeof alice, ts: number, content = [1, 2, 3], id = 'dmsg_0199aaaa-0000-7000-8000-000000000001') => signed(author, {
	message_id: id,
	dialog_hash: DIALOG,
	sender_hash: author.userHash,
	content_b64: toBase64(new Uint8Array(content)),
	deleted_flag: false,
	refs_map_b64: toBase64(new Uint8Array([9])),
	parent_sign_hash: null,
	owner_timestamp: ts,
}, 'dms_');
const storageRow = (author: typeof alice, ts: number) => signed(author, {
	user_hash: author.userHash,
	uuid: '0199aaaa-0000-7000-8000-00000000000a',
	value_b64: toBase64(new Uint8Array([4, 5, 6])),
	deleted_flag: false,
	parent_sign_hash: null,
	owner_timestamp: ts,
}, 'uss_');
const dialogKey = (author: typeof alice, peer: typeof alice, ts: number) => signed(author, {
	dialog_hash: DIALOG,
	sender_hash: author.userHash,
	peer_hash: peer.userHash,
	peer_kem_wrap_key_b64: toBase64(new Uint8Array([7, 7])),
	peer_wrapped_msg_key_b64: toBase64(new Uint8Array([8, 8])),
	owner_timestamp: ts,
	deleted_flag: false,
});
const reaction = (author: typeof alice) => signed(author, {
	reaction_hash: 'dmr_' + 'e'.repeat(128),
	dialog_hash: DIALOG,
	message_id: 'dmsg_0199aaaa-0000-7000-8000-000000000001',
	message_sign_hash: 'dms_' + 'f'.repeat(128),
	reactor_hash: author.userHash,
	type_b64: toBase64(new TextEncoder().encode('+1')),
	deleted_flag: false,
	owner_timestamp: 1_700_000_050,
});
const receipt = (author: typeof alice) => signed(author, {
	receipt_hash: 'dmrc_' + 'c'.repeat(128),
	dialog_hash: DIALOG,
	message_id: 'dmsg_0199aaaa-0000-7000-8000-000000000001',
	peer_hash: author.userHash,
	type: 'read',
	message_sign_hash: 'dms_' + 'f'.repeat(128),
	owner_timestamp: 1_700_000_060,
});
const unpadded = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
	[k, /(_b64|_pkey|_cert)$/.test(k) && typeof v === 'string' ? v.replace(/=+$/, '') : v]));
const insert = (relation: string, row: Row) => [{ type: 'insert', modified: row, syncMetadata: { relation } }];

const makeRaw = () => {
	const map = new Map<string, string>();
	return {
		map,
		locked: false,
		async get(k: string) { if (this.locked) throw new VaultLockedError('locked'); return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};
let acceptedStore: ReturnType<typeof makeRaw>;
let outboxStore: ReturnType<typeof makeRaw>;

const drainMicrotasks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const pass = async () => {
	ingest.drainPendingWrites(alice.userHash, alice.sign.secretKey);
	await drainMicrotasks();
	await outbox._drainLoopSettledForTests();
};
const entries = async () => Promise.all((await outboxStore.keys()).filter((k) => !k.includes('|')).map(async (k) => JSON.parse(outboxStore.map.get(k)!)));

beforeEach(async () => {
	http.bodies = [];
	barrier.visible = true;
	barrier.calls = 0;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	outboxStore = makeRaw();
	outbox._setStorageForTests(outboxStore);
	acceptedStore = makeRaw();
	acceptedSnapshot._setAcceptedSnapshotStorageForTests(acceptedStore);
	_setOwnObservedTailsStorageForTests(makeRaw());
	outbox.startLeaderElection(alice.userHash, () => {});
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
});

afterEach(async () => {
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

const MESSAGE_ID = 'dmsg_0199aaaa-0000-7000-8000-000000000001';
const lifecycleOf = (shapeRow: Row | null) =>
	readAcceptedOperation('dialog_messages', MESSAGE_ID, alice.userHash, { shapeRow, resolveSignPkey: resolve });

describe('HTTP acceptance is SERVER_ACCEPTED, and only that', () => {
	it('an accepted write with no shape row yet is neither visible nor verified', async () => {
		const handle = await ingest.sendMutationsAndAwaitShape(insert('dialog_messages', message(alice, 1_700_000_100)), alice.sign.secretKey);
		expect(handle.phase).toBe('accepted');
		const lifecycle = await lifecycleOf(null);
		expect(lifecycle).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'absent' });
		expect(lifecycle.phase).not.toBe('SHAPE_VISIBLE');
		expect(lifecycle.phase).not.toBe('VERIFIED');
	});

	it('a shape timeout after acceptance sends nothing again and keeps the accepted snapshot', async () => {
		barrier.visible = false;
		const ours = message(alice, 1_700_000_100);
		await ingest.sendMutationsAndAwaitShape(insert('dialog_messages', ours), alice.sign.secretKey);
		expect(barrier.calls).toBe(1);
		await pass();
		await pass();
		expect(http.bodies).toHaveLength(1);
		expect((await entries()).map((e) => e.status)).toEqual(['accepted']);
		expect(await acceptedSnapshot.getAccepted('dialog_messages', MESSAGE_ID, alice.userHash)).toEqual(ours);
		expect(await lifecycleOf(null)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'absent' });
	});

	it('a failed verification of the observed row sends nothing again and keeps the accepted snapshot', async () => {
		const ours = message(alice, 1_700_000_100);
		await ingest.sendMutationsAndAwaitShape(insert('dialog_messages', ours), alice.sign.secretKey);
		const forged = { ...ours, content_b64: toBase64(new Uint8Array([6, 6, 6])) };
		expect(await lifecycleOf(forged)).toMatchObject({ phase: 'SHAPE_VISIBLE', verification: { status: 'invalid', reason: 'bad_signature' } });
		await pass();
		await pass();
		expect(http.bodies).toHaveLength(1);
		expect(await acceptedSnapshot.getAccepted('dialog_messages', MESSAGE_ID, alice.userHash)).toEqual(ours);
		expect(await lifecycleOf(ours)).toMatchObject({ phase: 'VERIFIED' }); // the honest row still completes it
	});

	it('a reload between acceptance and shape arrival reads SERVER_ACCEPTED from the durable evidence', async () => {
		const ours = message(alice, 1_700_000_100);
		await ingest.sendMutationsAndAwaitShape(insert('dialog_messages', ours), alice.sign.secretKey);

		vi.resetModules();
		const reloadedSnapshot = await import('@/lib/data/acceptedSnapshot');
		reloadedSnapshot._setAcceptedSnapshotStorageForTests(acceptedStore);
		const reloaded = await import('@/lib/data/operationLifecycle');
		const read = (shapeRow: Row | null) =>
			reloaded.readAcceptedOperation('dialog_messages', MESSAGE_ID, alice.userHash, { shapeRow, resolveSignPkey: resolve });

		expect(await read(null)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'absent' });
		expect(await read(unpadded(ours))).toMatchObject({ phase: 'VERIFIED' });
	});
});

describe('matching: only this operation\'s exact revision is observed', () => {
	const ours = message(alice, 1_700_000_100);

	it('the right entity with another sign_hash does not complete the operation', () => {
		const other = message(alice, 1_700_000_100, [4, 4, 4]);
		expect(other.sign_hash).not.toBe(ours.sign_hash);
		expect(observeAcceptedOperation('dialog_messages', alice.userHash, ours, other)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'other_revision' });
		const borrowed = { ...other, sign_hash: ours.sign_hash };
		expect(observeAcceptedOperation('dialog_messages', alice.userHash, ours, borrowed)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'other_revision' });
		const relabelled = { ...ours, sign_hash: other.sign_hash };
		expect(observeAcceptedOperation('dialog_messages', alice.userHash, ours, relabelled)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'other_revision' });
	});

	it('the exact row is SHAPE_VISIBLE before verification, VERIFIED after it', async () => {
		const shapeRow = unpadded(ours);
		expect(observeAcceptedOperation('dialog_messages', alice.userHash, ours, shapeRow)).toEqual({ phase: 'SHAPE_VISIBLE', accepted: ours, row: shapeRow, verification: null });
		expect(await verifyAcceptedOperation('dialog_messages', alice.userHash, ours, shapeRow, resolve)).toEqual({ phase: 'VERIFIED', accepted: ours, row: shapeRow });
	});

	it('an invalid signature stays visible and unverified', async () => {
		const tampered = { ...ours, deleted_flag: true };
		expect(await verifyAcceptedOperation('dialog_messages', alice.userHash, ours, tampered, resolve)).toMatchObject({
			phase: 'SHAPE_VISIBLE', verification: { status: 'invalid', reason: 'bad_signature' },
		});
		const lying = { ...ours, sign_hash: 'dms_' + '0'.repeat(128) };
		expect(await verifyReplicatedRow('dialog_messages', lying, resolve)).toEqual({ status: 'invalid', reason: 'sign_hash_mismatch' });
	});

	it('another account\'s row or accepted snapshot is never used', async () => {
		const bobs = message(bob, 1_700_000_100);
		expect(observeAcceptedOperation('dialog_messages', alice.userHash, ours, bobs)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'foreign' });
		const impostor = signed(bob, { ...message(alice, 1_700_000_100), sign_b64: undefined, sign_hash: undefined }, 'dms_');
		expect(await verifyReplicatedRow('dialog_messages', impostor, resolve)).toEqual({ status: 'invalid', reason: 'bad_signature' });
		await acceptedSnapshot.recordAccepted('dialog_messages', MESSAGE_ID, bobs, bob.userHash);
		expect(await lifecycleOf(bobs)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
	});

	it('an older revision neither completes nor replaces the newer accepted one', async () => {
		const older = message(alice, 1_700_000_090, [0]);
		await acceptedSnapshot.recordAccepted('dialog_messages', MESSAGE_ID, ours, alice.userHash);
		await acceptedSnapshot.recordAccepted('dialog_messages', MESSAGE_ID, older, alice.userHash);
		expect(await acceptedSnapshot.getAccepted('dialog_messages', MESSAGE_ID, alice.userHash)).toEqual(ours);
		expect(await lifecycleOf(older)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'older' });
		expect(await lifecycleOf(message(alice, 1_700_000_200, [5]))).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'newer' });
	});
});

describe('cached, locked and missing are told apart', () => {
	it('a cached row is re-verified: a verified one and a tampered one read differently', async () => {
		const good = message(alice, 1_700_000_100);
		const bad: Row = { ...message(alice, 1_700_000_100, [1], 'dmsg_0199aaaa-0000-7000-8000-000000000002'), content_b64: toBase64(new Uint8Array([2])) };
		let emit: (changes: Array<{ key: unknown; value?: Row; type: string }>) => void = () => {};
		mirrorDialogTable({ subscribeChanges: (cb) => { emit = cb; return { unsubscribe() {} }; } }, 'dialog_messages');
		emit([{ key: good.message_id, value: unpadded(good), type: 'insert' }, { key: bad.message_id, value: unpadded(bad), type: 'insert' }]);
		const cached = async () => readDialogRows('dialog_messages', DIALOG);
		await vi.waitFor(async () => expect(await cached()).toHaveLength(2));

		const cachedGood = (await cached()).find((r) => r.message_id === good.message_id)!;
		const cachedBad = (await cached()).find((r) => r.message_id === bad.message_id)!;
		expect(await verifyReplicatedRow('dialog_messages', cachedGood, resolve)).toEqual({ status: 'verified' });
		expect(await verifyReplicatedRow('dialog_messages', cachedBad, resolve)).toEqual({ status: 'invalid', reason: 'bad_signature' });
	});

	it('a locked dependency is unavailable — not invalid, not missing', async () => {
		const ours = message(alice, 1_700_000_100);
		const locked = async () => { throw new VaultLockedError('locked'); };
		expect(await verifyReplicatedRow('dialog_messages', ours, locked)).toEqual({ status: 'unavailable', reason: 'locked' });
		expect(await verifyAcceptedOperation('dialog_messages', alice.userHash, ours, ours, locked)).toMatchObject({
			phase: 'SHAPE_VISIBLE', verification: { status: 'unavailable', reason: 'locked' },
		});
		expect(await verifyReplicatedRow('dialog_messages', ours, async () => null)).toEqual({ status: 'unavailable', reason: 'author_card_unavailable' });

		await acceptedSnapshot.recordAccepted('dialog_messages', MESSAGE_ID, ours, alice.userHash);
		acceptedStore.locked = true;
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'locked' });
	});
});

describe('acceptance evidence: proven missing is not unreadable', () => {
	const ours = message(alice, 1_700_000_100);
	const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	const sealedWith = (raw: ReturnType<typeof makeRaw>, getKey: () => Promise<CryptoKey>) => {
		const secure = createSecureStore(raw, { getKey });
		acceptedSnapshot._setAcceptedSnapshotStorageForTests(secure);
		return secure;
	};
	const withStoredText = async (text: string) => {
		const key = await newKey();
		await sealedWith(makeRaw(), async () => key).set(`dialog_messages:${MESSAGE_ID}`, text);
	};

	it('nothing stored: NOT_ACCEPTED', async () => {
		const key = await newKey();
		sealedWith(makeRaw(), async () => key);
		expect(await lifecycleOf(null)).toEqual({ phase: 'NOT_ACCEPTED' });
		expect(await readAcceptedOperation('user_storage', `${alice.userHash}|x`, alice.userHash, { shapeRow: null, resolveSignPkey: resolve })).toEqual({ phase: 'NOT_ACCEPTED' });
	});

	it('a record sealed under another key is unavailable evidence, not NOT_ACCEPTED', async () => {
		const raw = makeRaw();
		const theirs = await newKey();
		await sealedWith(raw, async () => theirs).set(`dialog_messages:${MESSAGE_ID}`, JSON.stringify(ours));
		await sealedWith(raw, async () => theirs).set(`user_storage:${alice.userHash}|x`, JSON.stringify(storageRow(alice, 1)));
		const mine = await newKey();
		sealedWith(raw, async () => mine);
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
		expect(await readAcceptedOperation('user_storage', `${alice.userHash}|x`, alice.userHash, { shapeRow: null, resolveSignPkey: resolve }))
			.toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
	});

	it('undecodable text or a non-object is unavailable evidence', async () => {
		await withStoredText('{not json');
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
		await withStoredText('[1,2]');
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
	});

	it('a readable row of another entity is not this acceptance', async () => {
		await withStoredText(JSON.stringify(message(alice, 1_700_000_100, [1], 'dmsg_0199aaaa-0000-7000-8000-00000000000f')));
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
	});

	it('a storage read failure is unavailable evidence', async () => {
		const raw = makeRaw();
		raw.get = async () => { throw new Error('disk read error'); };
		const key = await newKey();
		sealedWith(raw, async () => key);
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'unavailable' });
	});

	it('a locked vault is locked evidence', async () => {
		const raw = makeRaw();
		const key = await newKey();
		await sealedWith(raw, async () => key).set(`dialog_messages:${MESSAGE_ID}`, JSON.stringify(ours));
		sealedWith(raw, async () => { throw new VaultLockedError('locked'); });
		expect(await lifecycleOf(ours)).toEqual({ phase: 'EVIDENCE_UNAVAILABLE', reason: 'locked' });
	});

	it('an account switch is not a lifecycle state: it throws', async () => {
		const raw = makeRaw();
		const key = await newKey();
		await sealedWith(raw, async () => key).set(`dialog_messages:${MESSAGE_ID}`, JSON.stringify(ours));
		sealedWith(raw, async () => { throw new AccountMismatchError('another account is open'); });
		await expect(lifecycleOf(ours)).rejects.toBeInstanceOf(AccountMismatchError);
	});

	it('this account\'s readable record is the acceptance', async () => {
		const key = await newKey();
		await sealedWith(makeRaw(), async () => key).set(`dialog_messages:${MESSAGE_ID}`, JSON.stringify(ours));
		expect(await lifecycleOf(null)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'absent' });
		expect(await lifecycleOf(ours)).toMatchObject({ phase: 'VERIFIED' });
	});
});

describe('one boundary for every row family', () => {
	const families: Array<[string, Row, Row]> = [
		['user_cards', alice.card, { ...alice.card, name: 'mallory' }],
		['user_storage', storageRow(alice, 1_700_000_300), { ...storageRow(alice, 1_700_000_300), value_b64: toBase64(new Uint8Array([0])) }],
		['dialog_keys', dialogKey(alice, bob, 1_700_000_400), { ...dialogKey(alice, bob, 1_700_000_400), peer_hash: alice.userHash }],
		['dialog_messages', message(alice, 1_700_000_100), { ...message(alice, 1_700_000_100), owner_timestamp: 1_700_000_101 }],
		['dialog_messages_versions', message(alice, 1_700_000_100), { ...message(alice, 1_700_000_100), parent_sign_hash: 'dms_' + '1'.repeat(128) }],
		['dialog_message_reactions', reaction(alice), { ...reaction(alice), deleted_flag: true }],
		['dialog_message_receipts', receipt(alice), { ...receipt(alice), type: 'delivered' }],
	];

	it.each(families)('%s: its honest row verifies, a tampered one does not', async (relation, honest, tampered) => {
		expect(await verifyReplicatedRow(relation, unpadded(honest), resolve)).toEqual({ status: 'verified' });
		expect((await verifyReplicatedRow(relation, tampered, resolve)).status).toBe('invalid');
	});

	it('rows with a sign_hash column must carry it', async () => {
		const noHash = storageRow(alice, 1_700_000_300);
		delete noHash.sign_hash;
		expect(await verifyReplicatedRow('user_storage', noHash, resolve)).toEqual({ status: 'invalid', reason: 'missing_sign_hash' });
		const claimed = { ...storageRow(alice, 1_700_000_300), sign_hash: 'uss_' + '0'.repeat(128) };
		expect(await verifyReplicatedRow('user_storage', claimed, resolve)).toEqual({ status: 'invalid', reason: 'sign_hash_mismatch' });
		const noMsgHash = message(alice, 1_700_000_100);
		delete noMsgHash.sign_hash;
		expect(verifyRowWithKey('dialog_messages', noMsgHash, alice.card.sign_pkey as string)).toEqual({ status: 'invalid', reason: 'missing_sign_hash' });
	});

	it('a relation without local verification says so', async () => {
		expect(await verifyReplicatedRow('files', { file_id: 'f', uploader_hash: alice.userHash }, resolve)).toEqual({ status: 'unsupported', reason: 'no_local_verification' });
	});

	it('the lifecycle completes for user_storage, dialog_keys and user_cards on the same terms', async () => {
		const storage = storageRow(alice, 1_700_000_300);
		expect(await verifyAcceptedOperation('user_storage', alice.userHash, storage, unpadded(storage), resolve)).toMatchObject({ phase: 'VERIFIED' });
		expect(await verifyAcceptedOperation('user_storage', alice.userHash, storage, storageRow(bob, 1_700_000_300), resolve)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'foreign' });
		const key = dialogKey(alice, bob, 1_700_000_400);
		expect(await verifyAcceptedOperation('dialog_keys', alice.userHash, key, unpadded(key), resolve)).toMatchObject({ phase: 'VERIFIED' });
		expect(await verifyAcceptedOperation('dialog_keys', alice.userHash, key, dialogKey(alice, bob, 1_700_000_401), resolve)).toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'newer' });
		expect(await verifyAcceptedOperation('user_cards', alice.userHash, alice.card, unpadded(alice.card), resolve)).toMatchObject({ phase: 'VERIFIED' });
	});

	it('production verification of replicated rows goes through the boundary', () => {
		const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
		const store = source('src/store/dialogs.store.js');
		const gate = source('src/lib/data/dialogGate.ts');
		expect(store).toMatch(/from '@\/lib\/data\/rowVerification'/);
		expect(gate).toMatch(/from '@\/lib\/data\/rowVerification'/);
		for (const text of [store, gate]) expect(text).not.toMatch(/\bverify(MessageRow|SideRow)\(/);
	});
});
