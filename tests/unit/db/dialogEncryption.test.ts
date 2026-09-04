import { describe, it, expect, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { readAllFromIndexedDB, deleteFromIndexedDB } from '../testHelpers';

type DialogModule = typeof import('@/utils/db/tanstack/dialog');
type DialogsStoreModule = typeof import('@/store/dialogs.store');
type DialogsStore = ReturnType<DialogsStoreModule['useDialogsStore']>;
type PendingMessageRecord = NonNullable<ReturnType<DialogModule['pendingDialogMessagesCollection']['get']>>;
type PendingReactionRecord = NonNullable<ReturnType<DialogModule['pendingDialogReactionsCollection']['get']>>;
type PendingKeysRecord = NonNullable<ReturnType<DialogModule['pendingDialogKeysCollection']['get']>>;

const SECURITY_TEST_MESSAGE_CANARY = 'SECURITY_TEST_MESSAGE_CANARY_7f91c2';
const REACTION_CANARY = '\u{1F525}';

const MY_SIGN_SKEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const MY_CRYPT_SKEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const MY_EVM_SKEY_HEX = '11'.repeat(32);

const peerKem = ml_kem1024.keygen();
const peerCryptPkeyB64 = btoa(String.fromCharCode(...peerKem.publicKey));

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: 'u_me', currentUser: { user_hash: 'u_me' } }),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({ sign_skey: MY_SIGN_SKEY_B64, crypt_skey: MY_CRYPT_SKEY_B64, evm_skey: MY_EVM_SKEY_HEX }),
		}),
	},
}));

vi.mock('@/utils/db/tanstack/user', () => ({
	getUser: async (userHash: string) => (userHash === 'u_peer' ? { user_hash: 'u_peer', crypt_pkey: peerCryptPkeyB64 } : null),
}));

function createArrivalBarrier(expectedArrivals: number): { arrive: () => Promise<void> } {
	let arrived = 0;
	let release: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		arrive: async () => {
			arrived += 1;
			if (arrived >= expectedArrivals) release();
			await gate;
		},
	};
}

async function runConcurrentEdits<T>(calls: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
	const { DialogCrypto } = await import('@/libs/DialogCrypto');
	const realEncryptContent = DialogCrypto.encryptContent.bind(DialogCrypto);
	const barrier = createArrivalBarrier(calls.length);
	const spy = vi.spyOn(DialogCrypto, 'encryptContent').mockImplementation(async (key, plaintext) => {
		await barrier.arrive();
		return realEncryptContent(key, plaintext);
	});
	try {
		return await Promise.allSettled(calls.map((call) => call()));
	} finally {
		spy.mockRestore();
	}
}

async function freshStore(): Promise<{ store: DialogsStore; dialog: DialogModule }> {
	vi.resetModules();
	vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'DISABLE_SYNC' ? 'true' : null) });
	const { useDialogsStore } = await import('@/store/dialogs.store');
	setActivePinia(createPinia());
	const dialog = await import('@/utils/db/tanstack/dialog');
	return { store: useDialogsStore(), dialog };
}

async function deriveMyKeyForPeer(peerHash: string) {
	const { DialogCrypto } = await import('@/libs/DialogCrypto');
	const signSkey = Uint8Array.from(atob(MY_SIGN_SKEY_B64), (c) => c.charCodeAt(0));
	const kemSkey = Uint8Array.from(atob(MY_CRYPT_SKEY_B64), (c) => c.charCodeAt(0));
	return DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, MY_EVM_SKEY_HEX, peerHash);
}

function serializedContains(value: unknown, needle: string): boolean {
	return JSON.stringify(value).includes(needle);
}

async function sendAndAwaitPersisted(store: DialogsStore, dialog: DialogModule, text: string): Promise<{ messageId: string; record: PendingMessageRecord }> {
	const messageId = (await store.sendMessage('u_peer', text, () => {})) as unknown as string;
	let record: PendingMessageRecord | undefined;
	await vi.waitFor(() => {
		record = dialog.pendingDialogMessagesCollection.get(messageId);
		expect(record).toBeTruthy();
	});
	return { messageId, record: record! };
}

function findPendingReaction(dialog: DialogModule, messageId: string): PendingReactionRecord | undefined {
	return Array.from(dialog.pendingDialogReactionsCollection.values()).find((r) => r.message_id === messageId);
}

interface RawQueueEntry {
	table: string;
	key: string;
	record?: Record<string, unknown>;
	patch?: Record<string, unknown>;
	revision?: number;
}

async function readRawPendingEntry(table: string, key: string): Promise<RawQueueEntry | undefined> {
	const rows = (await readAllFromIndexedDB('dialog-pending-queue', 'pending')) as RawQueueEntry[];
	return rows.find((r) => r.table === table && r.key === key);
}

async function readRawCachedRow(table: string, key: string): Promise<(Record<string, unknown> & { __key: string }) | undefined> {
	const rows = (await readAllFromIndexedDB('dialog-synced-cache', table)) as Array<Record<string, unknown> & { __key: string }>;
	return rows.find((r) => r.__key === key);
}

async function createSyncedMessageWithSignHash(dialogHash: string | null, messageId: string): Promise<void> {
	if (!dialogHash) throw new Error('expected getDialogHash(...) to be non-null');
	const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
	await recordSynced('dialog_messages', messageId, {
		message_id: messageId,
		dialog_hash: dialogHash,
		sender_hash: 'u_peer',
		content_b64: 'unrelated-already-synced-content',
		deleted_flag: false,
		sign_hash: 'dms_' + 'e'.repeat(128),
	});
}

async function createSyncedOwnMessage(dialogHash: string | null, messageId: string, ownerTimestamp: number | bigint, signHash: string): Promise<void> {
	if (!dialogHash) throw new Error('expected getDialogHash(...) to be non-null');
	const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
	await recordSynced('dialog_messages', messageId, {
		message_id: messageId,
		dialog_hash: dialogHash,
		sender_hash: 'u_me',
		content_b64: 'synced-ciphertext-for-' + signHash,
		deleted_flag: false,
		owner_timestamp: ownerTimestamp,
		sign_hash: signHash,
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('message content — plaintext never persisted', () => {
	it('sendMessage: the persisted pending record contains ciphertext content_b64, not the plaintext canary, anywhere in its serialized form', async () => {
		const { store, dialog } = await freshStore();
		const { messageId, record } = await sendAndAwaitPersisted(store, dialog, SECURITY_TEST_MESSAGE_CANARY);

		expect(record.content_b64).toBeTruthy();
		expect(record.content_b64).not.toBe(SECURITY_TEST_MESSAGE_CANARY);
		expect(String(record.content_b64)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);
		expect(serializedContains(record, SECURITY_TEST_MESSAGE_CANARY)).toBe(false);

		const raw = await readRawPendingEntry('dialog_messages', messageId);
		expect(raw).toBeTruthy();
		expect(serializedContains(raw, SECURITY_TEST_MESSAGE_CANARY)).toBe(false);
		const rawContentB64 = raw!.record?.content_b64 ?? raw!.patch?.content_b64;
		expect(rawContentB64).toBeTruthy();
		expect(rawContentB64).not.toBe(SECURITY_TEST_MESSAGE_CANARY);
	});

	it('the encrypted content_b64 decrypts back to the exact original canary text via DialogCrypto.decryptContent', async () => {
		const { store, dialog } = await freshStore();
		const { record } = await sendAndAwaitPersisted(store, dialog, SECURITY_TEST_MESSAGE_CANARY);
		const { DialogCrypto } = await import('@/libs/DialogCrypto');

		const key = await deriveMyKeyForPeer('u_peer');
		const decryptedJson = await DialogCrypto.decryptContent(key, record.content_b64!);
		expect(JSON.parse(decryptedJson).text).toBe(SECURITY_TEST_MESSAGE_CANARY);
	});

	it('after recordSynced, the synced IndexedDB cache record also contains only ciphertext, and stripCacheMetadata does not decrypt it', async () => {
		const { store, dialog } = await freshStore();
		const { messageId, record } = await sendAndAwaitPersisted(store, dialog, SECURITY_TEST_MESSAGE_CANARY);
		const { recordSynced, cachedDialogMessagesCollection, stripCacheMetadata } = await import('@/utils/db/tanstack/dialogCache');

		await recordSynced('dialog_messages', messageId, { message_id: messageId, content_b64: record.content_b64 }, true);

		const cached = cachedDialogMessagesCollection.get(messageId)!;
		expect(serializedContains(cached, SECURITY_TEST_MESSAGE_CANARY)).toBe(false);

		const stripped = stripCacheMetadata(cached)!;
		expect(stripped.content_b64).toBe(record.content_b64); // unchanged, not decrypted
		expect(serializedContains(stripped, SECURITY_TEST_MESSAGE_CANARY)).toBe(false);

		const rawCached = await readRawCachedRow('dialog_messages', messageId);
		expect(rawCached).toBeTruthy();
		expect(rawCached!.content_b64).toBe(record.content_b64);
		expect(serializedContains(rawCached, SECURITY_TEST_MESSAGE_CANARY)).toBe(false);
	});

	it('editMessage: the edited pending record also carries only ciphertext for the new text, and decrypts to the new canary', async () => {
		const { store, dialog } = await freshStore();
		const editedCanary = SECURITY_TEST_MESSAGE_CANARY + '_edited';
		const { messageId } = await sendAndAwaitPersisted(store, dialog, SECURITY_TEST_MESSAGE_CANARY);

		await store.editMessage('u_peer', messageId, editedCanary);

		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(serializedContains(record, editedCanary)).toBe(false);
		const { DialogCrypto } = await import('@/libs/DialogCrypto');
		const key = await deriveMyKeyForPeer('u_peer');
		const decrypted = JSON.parse(await DialogCrypto.decryptContent(key, record.content_b64!));
		expect(decrypted.text).toBe(editedCanary);
	});

	it('two encryptions of the same plaintext with the same key produce different ciphertext (fresh nonce), both decrypting correctly — no exact-ciphertext snapshot', async () => {
		const { DialogCrypto } = await import('@/libs/DialogCrypto');
		const key = new Uint8Array(32).fill(3);
		const a = await DialogCrypto.encryptContent(key, SECURITY_TEST_MESSAGE_CANARY);
		const b = await DialogCrypto.encryptContent(key, SECURITY_TEST_MESSAGE_CANARY);
		expect(a).not.toBe(b);
		expect(await DialogCrypto.decryptContent(key, a)).toBe(SECURITY_TEST_MESSAGE_CANARY);
		expect(await DialogCrypto.decryptContent(key, b)).toBe(SECURITY_TEST_MESSAGE_CANARY);
	});
});

describe('editMessage — owner_timestamp is a strictly monotonic protocol version marker (BUG 3 / backend 422 "timestamp not newer" fix)', () => {
	it('Test A: owner_timestamp advances to "now" when now is later than the previous version; identity/chain/mutationType preserved', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_advances_to_now';
		const originalTimestamp = 100;
		const originalSignHash = 'dms_' + 'a'.repeat(128);
		await createSyncedOwnMessage(dialogHash, messageId, originalTimestamp, originalSignHash);

		vi.spyOn(Date, 'now').mockReturnValue(500_000); // Date.now() -> 500s

		await store.editMessage('u_peer', messageId, 'edited text');

		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(record.message_id).toBe(messageId);
		expect(Number(record.owner_timestamp)).toBe(500);
		expect(Number(record.owner_timestamp)).toBeGreaterThan(originalTimestamp);
		expect(record.parent_sign_hash).toBe(originalSignHash);

		const { resolvePendingDialogRecord } = await import('@/utils/db/tanstack/dialogQueue');
		expect(resolvePendingDialogRecord('dialog_messages', record, null).mutationType).toBe('update');
	});

	it('Test B: two edits in the same unsent round (before either is confirmed) coalesce onto the SAME outgoing owner_timestamp — no artificial re-bump for an already-pending mutation (PART 2/5)', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_same_second';
		await createSyncedOwnMessage(dialogHash, messageId, 500, 'dms_' + 'b'.repeat(128));

		vi.spyOn(Date, 'now').mockReturnValue(500_000);

		await store.editMessage('u_peer', messageId, 'edit 1');
		const afterEdit1 = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(afterEdit1.owner_timestamp)).toBe(501);

		await store.editMessage('u_peer', messageId, 'edit 2');
		const afterEdit2 = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(afterEdit2.owner_timestamp)).toBe(501);
		expect(Number(afterEdit2.owner_timestamp)).toBeGreaterThan(500);

		const raw = await readRawPendingEntry('dialog_messages', messageId);
		expect(raw?.revision).toBe(2);
	});

	it('Test C: an edit made after the wall clock rolls backward still advances strictly past the previous version', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_clock_rollback';
		await createSyncedOwnMessage(dialogHash, messageId, 1000, 'dms_' + 'c'.repeat(128));

		vi.spyOn(Date, 'now').mockReturnValue(900_000);

		await store.editMessage('u_peer', messageId, 'edited text');
		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(record.owner_timestamp)).toBe(1001);
	});

	it('Test D: a BigInt previous owner_timestamp (as hydrated from Electric) is safely advanced to a JSON-safe number', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_bigint_previous';
		await createSyncedOwnMessage(dialogHash, messageId, 1700000000n, 'dms_' + 'd'.repeat(128));

		vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000);

		await store.editMessage('u_peer', messageId, 'edited text');

		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(typeof record.owner_timestamp).not.toBe('bigint');
		expect(Number(record.owner_timestamp)).toBe(1700000001);

		const { toProtocolRecord } = await import('@/utils/db/tanstack/dialogQueue');
		const protocolRecord = toProtocolRecord('dialog_messages', record);
		expect(typeof protocolRecord.owner_timestamp).toBe('number');
		expect(() => JSON.stringify(protocolRecord)).not.toThrow();
	});

	it('the pending queue entry key stays dialog_messages:<same message_id> — the edit updates the existing row, it does not create a new one', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_same_key';
		await createSyncedOwnMessage(dialogHash, messageId, 200, 'dms_' + 'e'.repeat(128));

		await store.editMessage('u_peer', messageId, 'edited text');

		const raw = await readRawPendingEntry('dialog_messages', messageId);
		expect(raw).toBeTruthy();
		expect(raw!.key).toBe(messageId);
		expect(dialog.pendingDialogMessagesCollection.get(messageId)?.message_id).toBe(messageId);
	});

	it('repeated edits (each acked before the next) keep advancing owner_timestamp and the parent_sign_hash chain', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_repeated';
		const originalTimestamp = 200;
		const signHashV1 = 'dms_' + '1'.repeat(128);
		await createSyncedOwnMessage(dialogHash, messageId, originalTimestamp, signHashV1);

		vi.spyOn(Date, 'now').mockReturnValue(200_000);

		await store.editMessage('u_peer', messageId, 'edit 1');
		const afterEdit1 = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(afterEdit1.owner_timestamp)).toBe(201);
		expect(afterEdit1.parent_sign_hash).toBe(signHashV1);
		dialog.pendingDialogMessagesCollection.delete(messageId);
		await deleteFromIndexedDB('dialog-pending-queue', 'pending', `dialog_messages:${messageId}`);
		const signHashV2 = 'dms_' + '2'.repeat(128);
		await createSyncedOwnMessage(dialogHash, messageId, 201, signHashV2);

		await store.editMessage('u_peer', messageId, 'edit 2');
		const afterEdit2 = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(afterEdit2.owner_timestamp)).toBe(202);
		expect(afterEdit2.parent_sign_hash).toBe(signHashV2);
	});

	it('throws instead of silently minting a fresh timestamp when the existing message has no owner_timestamp (data-integrity guard)', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_edit_missing_timestamp';
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', messageId, {
			message_id: messageId,
			dialog_hash: dialogHash!,
			sender_hash: 'u_me',
			content_b64: 'synced-ciphertext',
			deleted_flag: false,
			sign_hash: 'dms_' + 'c'.repeat(128),
			owner_timestamp: null,
		});

		await expect(store.editMessage('u_peer', messageId, 'edited text')).rejects.toThrow(/owner_timestamp/);
		expect(dialog.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
	});
});

describe('editMessage — rapid/concurrent edits of the same message coalesce instead of racing (PART 1-5, Test A-F)', () => {
	it('a second edit fired before the first is acked does NOT inherit the pending row\'s null sign_hash as its parent (PART 1 simple repro, PART 3)', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_backtoback_edits';
		const originalSignHash = 'dms_' + 'a'.repeat(128);
		await createSyncedOwnMessage(dialogHash, messageId, 100, originalSignHash);

		await store.editMessage('u_peer', messageId, 'edit A');
		await store.editMessage('u_peer', messageId, 'edit B');

		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(record.parent_sign_hash).toBe(originalSignHash);
		expect(record.parent_sign_hash).not.toBeNull();

		const { resolvePendingDialogRecord } = await import('@/utils/db/tanstack/dialogQueue');
		expect(resolvePendingDialogRecord('dialog_messages', record, null).mutationType).toBe('update');

		const raw = await readRawPendingEntry('dialog_messages', messageId);
		expect(raw?.revision).toBe(2);
	});

	it('Test A/B/C/F: two genuinely concurrent edits, forced to read the SAME confirmed base, coalesce into exactly one valid pending update — latest write wins, no duplicate/conflicting entries', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_true_concurrent_edit';
		const originalSignHash = 'dms_' + 'a'.repeat(128);
		await createSyncedOwnMessage(dialogHash, messageId, 100, originalSignHash);
		const results = await runConcurrentEdits([
			() => store.editMessage('u_peer', messageId, 'edit A'),
			() => store.editMessage('u_peer', messageId, 'edit B'),
		]);

		expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

		const raw = await readRawPendingEntry('dialog_messages', messageId);
		expect(raw).toBeTruthy();
		expect(raw!.revision).toBe(2);

		const record = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(record.message_id).toBe(messageId);
		expect(record.parent_sign_hash).toBe(originalSignHash);
		const outTs = Number(record.owner_timestamp);
		expect(Number.isSafeInteger(outTs)).toBe(true);
		expect(outTs).toBeGreaterThan(100);

		const { resolvePendingDialogRecord, toProtocolRecord } = await import('@/utils/db/tanstack/dialogQueue');
		expect(resolvePendingDialogRecord('dialog_messages', record, null).mutationType).toBe('update');
		expect(() => JSON.stringify(toProtocolRecord('dialog_messages', record))).not.toThrow();

		const { DialogCrypto } = await import('@/libs/DialogCrypto');
		const key = await deriveMyKeyForPeer('u_peer');
		const decrypted = JSON.parse(await DialogCrypto.decryptContent(key, record.content_b64!));
		expect(['edit A', 'edit B']).toContain(decrypted.text);
	});
});

describe('Page_Chat display helpers — edit no longer moves the message or changes its shown time (PART 3/5)', () => {
	it('getDialogMessageDisplayTimestamp derives the bubble time from the immutable UUIDv7 creation time, not the (now-advanced) owner_timestamp', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');

		const { messageId, record } = await sendAndAwaitPersisted(store, dialog, 'first version');
		const { getDialogMessageCreatedAtMs, getDialogMessageDisplayTimestamp } = await import('@/utils/db/tanstack/dialogDisplay');
		const createdAtMs = getDialogMessageCreatedAtMs(messageId);
		expect(createdAtMs).not.toBeNull();
		const expectedDisplaySec = createdAtMs! / 1000;

		const sentAtSec = Number(record.owner_timestamp);
		dialog.pendingDialogMessagesCollection.delete(messageId);
		await deleteFromIndexedDB('dialog-pending-queue', 'pending', `dialog_messages:${messageId}`);
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', messageId, {
			message_id: messageId,
			dialog_hash: dialogHash!,
			sender_hash: 'u_me',
			content_b64: record.content_b64,
			deleted_flag: false,
			owner_timestamp: sentAtSec,
			sign_hash: 'dms_' + 'f'.repeat(128),
		});

		const editedAtSec = sentAtSec + 100_000;
		vi.spyOn(Date, 'now').mockReturnValue(editedAtSec * 1000);
		await store.editMessage('u_peer', messageId, 'edited version');
		const edited = dialog.pendingDialogMessagesCollection.get(messageId)!;
		expect(Number(edited.owner_timestamp)).toBe(editedAtSec);
		expect(Number(edited.owner_timestamp)).not.toBe(expectedDisplaySec);

		expect(getDialogMessageDisplayTimestamp(edited)).toBe(expectedDisplaySec);
	});
});

describe('reaction content — plaintext emoji never persisted', () => {
	it('toggleReaction (add): persisted pending record has type_b64 ciphertext, and no plaintext emoji field anywhere in its serialized form', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_synced_for_reaction_1';
		await createSyncedMessageWithSignHash(dialogHash, messageId);

		await store.toggleReaction('u_peer', messageId, REACTION_CANARY, () => {});
		let reactionRow: PendingReactionRecord | undefined;
		await vi.waitFor(() => {
			reactionRow = findPendingReaction(dialog, messageId);
			expect(reactionRow).toBeTruthy();
		});
		const reaction = reactionRow!;

		expect(reaction.type_b64).toBeTruthy();
		expect(reaction.type_b64).not.toBe(REACTION_CANARY);
		expect(serializedContains(reaction, REACTION_CANARY)).toBe(false);
		expect('type' in reaction).toBe(false);
		expect('emoji' in reaction).toBe(false);

		const raw = await readRawPendingEntry('dialog_message_reactions', reaction.reaction_hash);
		expect(raw).toBeTruthy();
		expect(serializedContains(raw, REACTION_CANARY)).toBe(false);
		const rawTypeB64 = raw!.record?.type_b64 ?? raw!.patch?.type_b64;
		expect(rawTypeB64).toBeTruthy();
		expect(rawTypeB64).not.toBe(REACTION_CANARY);
	});

	it('the reaction type_b64 decrypts back to the exact original emoji', async () => {
		const { store, dialog } = await freshStore();
		const dialogHash = store.getDialogHash('u_peer');
		const messageId = 'dmsg_synced_for_reaction_2';
		await createSyncedMessageWithSignHash(dialogHash, messageId);

		await store.toggleReaction('u_peer', messageId, REACTION_CANARY, () => {});
		let reactionRow: PendingReactionRecord | undefined;
		await vi.waitFor(() => {
			reactionRow = findPendingReaction(dialog, messageId);
			expect(reactionRow).toBeTruthy();
		});

		const { DialogCrypto } = await import('@/libs/DialogCrypto');
		const key = await deriveMyKeyForPeer('u_peer');
		const decrypted = await DialogCrypto.decryptContent(key, reactionRow!.type_b64!);
		expect(decrypted).toBe(REACTION_CANARY);
	});
});

describe('dialog key storage — wrapped keys only, no raw secret/session key material', () => {
	it('the persisted dialog_keys pending record has only the documented protocol fields, never a raw sender/session/secret key field or value', async () => {
		const { store, dialog } = await freshStore();
		await sendAndAwaitPersisted(store, dialog, 'trigger key creation');

		const dialogHash = store.getDialogHash('u_peer');
		let keysRow: PendingKeysRecord | undefined;
		await vi.waitFor(() => {
			keysRow = dialog.pendingDialogKeysCollection.get(`${dialogHash}:u_me`);
			expect(keysRow).toBeTruthy();
		});
		const keys = keysRow!;

		expect(keys.peer_kem_wrap_key_b64).toBeTruthy();
		expect(keys.peer_wrapped_msg_key_b64).toBeTruthy();

		const forbiddenFieldNames = ['senderMsgKey', 'sender_msg_key', 'msg_key', 'message_key', 'sign_skey', 'crypt_skey', 'kem_skey', 'contact_skey'];
		for (const field of forbiddenFieldNames) {
			expect(Object.keys(keys)).not.toContain(field);
		}
		
		const serializedValues = JSON.stringify(Object.values(keys));
		expect(serializedValues).not.toContain(MY_SIGN_SKEY_B64);
		expect(serializedValues).not.toContain(MY_CRYPT_SKEY_B64);

		const raw = await readRawPendingEntry('dialog_keys', `${dialogHash}:u_me`);
		expect(raw).toBeTruthy();
		const rawKeys = (raw!.record ?? raw!.patch)!;
		for (const field of forbiddenFieldNames) {
			expect(Object.keys(rawKeys)).not.toContain(field);
		}
		const rawSerializedValues = JSON.stringify(Object.values(rawKeys));
		expect(rawSerializedValues).not.toContain(MY_SIGN_SKEY_B64);
		expect(rawSerializedValues).not.toContain(MY_CRYPT_SKEY_B64);
	});
});
