import { describe, it, expect, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import type { ApiMutation } from '@/api/client';
import type { DialogTable } from '@/utils/db/tanstack/dialogQueue';
import { modifiedOf } from '../testHelpers';

type DialogModule = typeof import('@/utils/db/tanstack/dialog');
type DialogCacheModule = typeof import('@/utils/db/tanstack/dialogCache');
type DialogsStoreModule = typeof import('@/store/dialogs.store');
type DialogsStore = ReturnType<DialogsStoreModule['useDialogsStore']>;

type PendingMessageRecord = NonNullable<ReturnType<DialogModule['pendingDialogMessagesCollection']['get']>>;
type CachedMessageRecord = NonNullable<ReturnType<DialogCacheModule['cachedDialogMessagesCollection']['get']>> & { __awaitingEcho?: boolean };
type MessagesChange = Parameters<DialogModule['handleDialogMessagesChanges']>[0][number];

function withVirtualProps<Row extends Record<string, unknown>>(value: Row, key: string) {
	return { ...value, $synced: true as const, $origin: 'local' as const, $key: key, $collectionId: 'test' };
}

const SECURITY_TEST_MESSAGE_CANARY = 'SECURITY_TEST_MESSAGE_CANARY_7f91c2';
const REACTION_CANARY = '\u{1F525}';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';

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

interface IngestEachBody {
	auth: { challenge_id: string; signature: string };
	mutations: ApiMutation[];
}

let lastCapturedBody: IngestEachBody | null = null;

function ingestEachResult(status: string, error?: string) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url.includes('/challenge')) {
			return { ok: true, json: async () => ({ challenge: 'chal', challenge_id: 'cid' }) } as unknown as Response;
		}
		if (url.includes('/ingest_each')) {
			const body = typeof init?.body === 'string' ? init.body : '';
			const parsed = JSON.parse(body) as IngestEachBody;
			lastCapturedBody = parsed;
			const results = parsed.mutations.map((_, i) => (error ? { index: i, status, error } : { index: i, status }));
			return { ok: true, json: async () => ({ results }) } as unknown as Response;
		}
		throw new Error(`unexpected fetch to ${url}`);
	});
}

function mockSuccessfulTransport() {
	vi.stubGlobal('fetch', ingestEachResult('ok'));
}

function mockFailingTransportOnce() {
	vi.stubGlobal('fetch', ingestEachResult('error', 'server_error'));
}

async function freshApp(): Promise<{ dialogQueue: typeof import('@/utils/db/tanstack/dialogQueue'); dialogCache: DialogCacheModule; dialog: DialogModule; store: DialogsStore }> {
	vi.resetModules();
	vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'DISABLE_SYNC' ? 'true' : null) });
	const dialogQueue = await import('@/utils/db/tanstack/dialogQueue');
	const dialogCache = await import('@/utils/db/tanstack/dialogCache');
	const dialog = await import('@/utils/db/tanstack/dialog');
	await dialog.ensureDialogReady();
	const { useDialogsStore } = await import('@/store/dialogs.store');
	setActivePinia(createPinia());
	const store = useDialogsStore();
	return { dialogQueue, dialogCache, dialog, store };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('happy path — pending, ingest success, ack, Electric echo, reload durability', () => {
	it('a sent message goes pending -> synced (awaitingEcho=true) -> echo clears awaitingEcho -> survives a simulated reload, with plaintext never persisted at any step', async () => {
		const { dialogQueue, dialogCache, dialog, store } = await freshApp();
		const messageId = (await store.sendMessage('u_peer', SECURITY_TEST_MESSAGE_CANARY, () => {})) as unknown as string;
		let pendingRecord: PendingMessageRecord | undefined;
		await vi.waitFor(() => {
			pendingRecord = dialog.pendingDialogMessagesCollection.get(messageId);
			expect(pendingRecord).toBeTruthy();
		});
		expect(JSON.stringify(pendingRecord)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);

		mockSuccessfulTransport();
		const { ml_dsa87 } = await import('@noble/post-quantum/ml-dsa.js');
		const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(5)).secretKey;
		await dialogQueue.flushPendingDialogChanges(signSkey, 'u_me');

		expect(lastCapturedBody).toBeTruthy();
		const wireBodyText = JSON.stringify(lastCapturedBody);
		expect(wireBodyText).not.toContain(SECURITY_TEST_MESSAGE_CANARY);
		const messageMutation = lastCapturedBody!.mutations.find((m) => m.syncMetadata.relation === 'dialog_messages');
		expect(messageMutation).toBeTruthy();
		expect(modifiedOf(messageMutation!).content_b64).toBeTruthy();
		for (const forbidden of ['ownerUserHash', '__awaitingEcho', '__ignoreEchoSignHash', '"revision"', 'sentSnapshot', 'sentRevision', '"status"', 'lastError']) {
			expect(wireBodyText).not.toContain(forbidden);
		}

		expect(dialog.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
		const syncedCache = dialogCache.cachedDialogMessagesCollection.get(messageId) as CachedMessageRecord | undefined;
		expect(syncedCache).toBeTruthy();
		const synced = syncedCache!;
		expect(synced.__awaitingEcho).toBe(true);
		expect(JSON.stringify(synced)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);

		const echoChange: MessagesChange = {
			type: 'insert',
			key: messageId,
			value: withVirtualProps({ message_id: messageId, content_b64: synced.content_b64 }, messageId),
		};
		dialog.handleDialogMessagesChanges([echoChange]);
		const afterEcho = dialogCache.cachedDialogMessagesCollection.get(messageId) as CachedMessageRecord | undefined;
		expect(afterEcho?.__awaitingEcho).toBe(false);
		expect(JSON.stringify(afterEcho)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);

		vi.resetModules();
		vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'DISABLE_SYNC' ? 'true' : null) });
		const dialogCache2 = await import('@/utils/db/tanstack/dialogCache');
		await dialogCache2.ensureDialogCacheHydrated();
		const dialogQueue2 = await import('@/utils/db/tanstack/dialogQueue');
		await dialogQueue2.ensureRehydrated();

		const reloaded = dialogCache2.cachedDialogMessagesCollection.get(messageId);
		expect(reloaded).toBeTruthy();
		expect(reloaded?.content_b64).toBe(synced.content_b64);
		expect(JSON.stringify(reloaded)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);
		expect(dialogQueue2.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();

		const { DialogCrypto } = await import('@/libs/DialogCrypto');
		const signSkeyBytes = Uint8Array.from(atob(MY_SIGN_SKEY_B64), (c) => c.charCodeAt(0));
		const kemSkeyBytes = Uint8Array.from(atob(MY_CRYPT_SKEY_B64), (c) => c.charCodeAt(0));
		const key = await DialogCrypto.deriveSenderMsgKey(signSkeyBytes, kemSkeyBytes, MY_EVM_SKEY_HEX, 'u_peer');
		const decrypted = JSON.parse(await DialogCrypto.decryptContent(key, reloaded!.content_b64!));
		expect(decrypted.text).toBe(SECURITY_TEST_MESSAGE_CANARY);
	});
});

describe('reaction — real encryption, real flush, actual wire body has no literal emoji', () => {
	it('toggleReaction on an already-synced message: the /ingest_each body carries type_b64 ciphertext, never the literal emoji', async () => {
		const { dialogQueue, dialogCache, dialog, store } = await freshApp();

		const dialogHash = store.getDialogHash('u_peer');
		if (!dialogHash) throw new Error('expected getDialogHash(...) to be non-null');
		const messageId = 'dmsg_synced_for_reaction_wire';
		await dialogCache.recordSynced('dialog_messages', messageId, {
			message_id: messageId,
			dialog_hash: dialogHash,
			sender_hash: 'u_peer',
			content_b64: 'unrelated-already-synced-content',
			deleted_flag: false,
			sign_hash: 'dms_' + 'e'.repeat(128),
		});

		await store.toggleReaction('u_peer', messageId, REACTION_CANARY, () => {});
		await vi.waitFor(() => {
			const reactions = Array.from(dialog.pendingDialogReactionsCollection.values());
			expect(reactions.some((r) => r.message_id === messageId)).toBe(true);
		});

		mockSuccessfulTransport();
		const { ml_dsa87 } = await import('@noble/post-quantum/ml-dsa.js');
		const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(8)).secretKey;
		await dialogQueue.flushPendingDialogChanges(signSkey, 'u_me');

		expect(lastCapturedBody).toBeTruthy();
		const wireBodyText = JSON.stringify(lastCapturedBody);
		expect(wireBodyText).not.toContain(REACTION_CANARY);
		const reactionMutation = lastCapturedBody!.mutations.find((m) => m.syncMetadata.relation === 'dialog_message_reactions');
		expect(reactionMutation).toBeTruthy();
		expect(modifiedOf(reactionMutation!).type_b64).toBeTruthy();
	});
});

describe('normal durable retry — a temporary failure survives a reload and succeeds on the next attempt', () => {
	it('pending entry created, flush fails once (stays pending, durable across reload), a later flush succeeds and clears it', async () => {
		const { dialogQueue: q1 } = await freshApp();
		const { ml_dsa87 } = await import('@noble/post-quantum/ml-dsa.js');
		const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(6)).secretKey;

		await q1.putPendingDialog(
			'dialog_messages',
			{ message_id: 'dmsg_retry_1', dialog_hash: 'di_' + 'f'.repeat(128), sender_hash: 'u_me', content_b64: 'ciphertext', deleted_flag: false, owner_timestamp: 100 },
			'u_me'
		);

		mockFailingTransportOnce();
		const failResult = await q1.flushPendingDialogChanges(signSkey, 'u_me');
		expect(failResult?.retryAfterMs).toBeGreaterThan(0);
		expect(q1.pendingDialogMessagesCollection.get('dmsg_retry_1')).toBeTruthy();

		vi.resetModules();
		vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'DISABLE_SYNC' ? 'true' : null) });
		const q2 = await import('@/utils/db/tanstack/dialogQueue');
		await q2.ensureRehydrated();
		expect(q2.pendingDialogMessagesCollection.get('dmsg_retry_1')).toMatchObject({ content_b64: 'ciphertext' });

		const synced: Array<{ table: DialogTable; key: string }> = [];
		q2.setSyncedRecorder((table, key) => {
			synced.push({ table, key });
		});
		mockSuccessfulTransport();
		const okResult = await q2.flushPendingDialogChanges(signSkey, 'u_me');
		expect(okResult).toBeUndefined();
		expect(q2.pendingDialogMessagesCollection.get('dmsg_retry_1')).toBeUndefined();
		expect(synced).toHaveLength(1);
		expect(synced[0].key).toBe('dmsg_retry_1');

		q2.setSyncedRecorder(null);
	});
});
