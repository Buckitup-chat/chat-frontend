// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent } from '@/lib/pq/content';
import { DialogCrypto } from '@/libs/DialogCrypto';
import type { UserCardRow } from '@/lib/data/types';
import type { DialogCacheTable } from '@/lib/data/dialogCache';
import type { App } from './helpers/twoClients';

type Identity = ReturnType<typeof makeIdentity>;
type SenderKey = ReturnType<typeof DialogCrypto.deriveSenderMsgKey>;
type Dialog = Awaited<ReturnType<typeof buildDialog>>;
type DialogCacheModule = typeof import('@/lib/data/dialogCache');

const makeIdentity = (seed: number, name: string) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash, sign_pkey: toBase64(sign.publicKey), crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk), contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name, deleted_flag: false, owner_timestamp: 1_700_000_000,
	} as UserCardRow;
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return { sign, kem, contactSk, userHash, card };
};
const A = makeIdentity(40, 'Alice');
const B = makeIdentity(41, 'Bob');
const PEER = makeIdentity(42, 'Peer');

const vaultOf = (who: Identity) => {
	const data = new Map<string, unknown>([
		['sign_skey', who.sign.secretKey], ['crypt_skey', who.kem.secretKey],
		['evm_skey', bytesToHex(who.contactSk)], ['contact_skey', bytesToHex(who.contactSk)],
	]);
	return { async get(k: string) { return data.get(k); }, async set(k: string, v: unknown) { data.set(k, v); } };
};
const vaults = new Map([['vault-a', vaultOf(A)], ['vault-b', vaultOf(B)]]);
const registry = [A, B].map((who, i) => ({
	user_hash: who.userHash, vaultId: i === 0 ? 'vault-a' : 'vault-b', name: who.card.name,
	crypt_pkey: who.card.crypt_pkey, sign_pkey: who.card.sign_pkey,
}));
vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID }: { vaultID: string }) => vaults.get(vaultID),
	rawStorage: () => ({
		async get(k: string) { return k === 'pq-vaults-registry' ? registry : undefined; },
		async set() {},
		async remove() {},
	}),
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));

const cardsCollection = {
	rows: new Map([A, B, PEER].map((who) => [who.userHash, who.card])),
	async preload() {},
	get(k: string) { return this.rows.get(k); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
};
const unreachable = () => ({
	async preload() { throw new Error('Electric unreachable'); },
	get() { return undefined; },
	get toArray() { return []; },
	subscribeChanges() { return { unsubscribe() {} }; },
});
vi.mock('@/lib/data/collections', () => {
	const dialog = { keys: unreachable(), messages: unreachable(), versions: unreachable(), reactions: unreachable(), receipts: unreachable() };
	return {
		getUserCardsCollection: () => cardsCollection,
		getDialogCollections: () => dialog,
		withDialogCollections: async (_h: string, read: (collections: typeof dialog) => unknown) => read(dialog),
		getUserStorageCollection: () => unreachable(),
		resetUserStorageCollection: () => {},
		releaseDialogCollections: () => {},
	};
});

const HOLDER = vi.hoisted(() => ({ peer: '' }));
vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { get address() { return HOLDER.peer; } }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const dialogHashOf = (me: Identity, peer: Identity) => DialogCrypto.computeDialogHash(me.userHash, peer.userHash);
const senderKeyOf = (author: Identity, other: Identity) => DialogCrypto.deriveSenderMsgKey(author.sign.secretKey, author.kem.secretKey, bytesToHex(author.contactSk), other.userHash);

const signedMessage = async (dialogHash: string, key: SenderKey, id: string, text: string, tweak: Record<string, unknown> = {}) => {
	const fields = {
		message_id: id, dialog_hash: dialogHash, sender_hash: PEER.userHash,
		content_b64: await DialogCrypto.encryptContent(key, encodeContent([{ kind: 'text', text }])),
		deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(key, JSON.stringify({})),
		parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
	};
	const sign_b64 = signFields(fields as never, PEER.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
};

const buildDialog = async () => {
	const dialogHash = dialogHashOf(A, PEER);
	const key = senderKeyOf(PEER, A);
	const wrapped = await DialogCrypto.wrapSenderMsgKey(key, A.kem.publicKey);
	const keysRow = {
		dialog_hash: dialogHash, sender_hash: PEER.userHash, peer_hash: A.userHash,
		peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
		deleted_flag: false, owner_timestamp: 999,
	};

	const original = await signedMessage(dialogHash, key, 'dmsg_' + '1'.repeat(8) + '-0000-7000-8000-000000000000', 'first version', { owner_timestamp: 1_700_000_400 });
	const edited = await signedMessage(dialogHash, key, original.message_id, 'history from disk', {
		refs_map_b64: await DialogCrypto.encryptContent(key, JSON.stringify({ [original.message_id]: original.sign_hash })),
		parent_sign_hash: original.sign_hash, owner_timestamp: 1_700_000_900,
	});
	const citingEdited = await DialogCrypto.encryptContent(key, JSON.stringify({ [edited.message_id]: edited.sign_hash }));
	const tombstone = await signedMessage(dialogHash, key, 'dmsg_' + '2'.repeat(8) + '-0000-7000-8000-000000000000', '', {
		deleted_flag: true, content_b64: '', refs_map_b64: citingEdited, owner_timestamp: 1_700_000_950,
	});
	const forgedTombstone0 = await signedMessage(dialogHash, key, 'dmsg_' + '3'.repeat(8) + '-0000-7000-8000-000000000000', 'still here', {
		refs_map_b64: citingEdited, owner_timestamp: 1_700_000_960,
	});
	const forgedTombstone = { ...forgedTombstone0, deleted_flag: true };

	const signedReaction = async (emoji: string) => {
		const fields = {
			reaction_hash: DialogCrypto.computeReactionHash(key, edited.message_id, PEER.userHash, emoji),
			dialog_hash: dialogHash, message_id: edited.message_id, message_sign_hash: edited.sign_hash,
			reactor_hash: PEER.userHash, type_b64: await DialogCrypto.encryptContent(key, emoji),
			deleted_flag: false, owner_timestamp: 1_700_001_000,
		};
		return { ...fields, sign_b64: signFields(fields as never, PEER.sign.secretKey) };
	};
	const goodReaction = await signedReaction('👍');
	const forgedReaction = { ...(await signedReaction('🔥')), type_b64: await DialogCrypto.encryptContent(key, '💀') };

	const receipt = (by: Identity, signer: Identity) => {
		const fields = {
			receipt_hash: DialogCrypto.computeReceiptHash(edited.message_id, edited.sign_hash, by.userHash, 'read'),
			dialog_hash: dialogHash, message_id: edited.message_id, peer_hash: by.userHash, type: 'read',
			message_sign_hash: edited.sign_hash, owner_timestamp: 1_700_001_100,
		};
		return { ...fields, sign_b64: signFields(fields as never, signer.sign.secretKey) };
	};

	return {
		dialogHash,
		edited, tombstone, forgedTombstone, goodReaction, forgedReaction,
		tables: {
			dialog_keys: { [`${dialogHash}|${PEER.userHash}`]: keysRow },
			dialog_messages: { [edited.message_id]: edited, [tombstone.message_id]: tombstone, [forgedTombstone.message_id]: forgedTombstone },
			dialog_messages_versions: { [`${original.message_id}|${original.sign_hash}`]: original },
			dialog_message_reactions: { [goodReaction.reaction_hash]: goodReaction, [forgedReaction.reaction_hash]: forgedReaction },
			dialog_message_receipts: { good: receipt(A, A), forged: receipt(PEER, A) },
		},
	};
};

const DIALOG_TABLES = ['dialog_keys', 'dialog_messages', 'dialog_messages_versions', 'dialog_message_reactions', 'dialog_message_receipts'];
const readCacheKeys = () => new Promise<string[]>((resolve, reject) => {
	const req = indexedDB.open('dialog-synced-cache', 2);
	req.onupgradeneeded = () => {
		for (const t of DIALOG_TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t, { keyPath: '__key' });
	};
	req.onerror = () => reject(req.error);
	req.onsuccess = () => {
		const db = req.result;
		const tx = db.transaction(DIALOG_TABLES, 'readonly');
		const keys: string[] = [];
		for (const t of DIALOG_TABLES) {
			const r = tx.objectStore(t).getAllKeys();
			r.onsuccess = () => { for (const k of r.result) keys.push(`${t}:${k}`); };
		}
		tx.oncomplete = () => { db.close(); resolve(keys.sort()); };
	};
});
const whenIdb = (method: 'put', keys: string[]) => new Promise<void>((resolve) => {
	const pending = new Set(keys);
	const original = IDBObjectStore.prototype[method];
	IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
		const request = original.apply(this, args);
		const key = `${this.name}:${method === 'put' ? args[0]?.__key : args[0]}`;
		if (pending.has(key)) {
			request.addEventListener('success', () => {
				pending.delete(key);
				if (pending.size === 0) {
					IDBObjectStore.prototype[method] = original;
					resolve();
				}
			});
		}
		return request;
	};
	if (pending.size === 0) resolve();
});
const cacheKeysOf = (dialog: Dialog) => Object.entries(dialog.tables)
	.flatMap(([table, rows]) => Object.values(rows).map((row) => `${table}:${keyFor(table as DialogCacheTable, row)}`)).sort();
const keyFor = (table: DialogCacheTable, r: Record<string, unknown>) => ({
	dialog_keys: `${r.dialog_hash}:${r.sender_hash}`,
	dialog_messages: r.message_id,
	dialog_messages_versions: `${r.message_id}:${r.sign_hash}`,
	dialog_message_reactions: r.reaction_hash,
	dialog_message_receipts: r.receipt_hash,
})[table];
const collectionKeyFor = (table: never, r: Record<string, unknown>) => ({
	dialog_keys: `${r.dialog_hash}|${r.sender_hash}`,
	dialog_messages_versions: `${r.message_id}|${r.sign_hash}`,
})[table] ?? keyFor(table, r);

let app: { store: App['store']; readCache: DialogCacheModule } | null = null;
const startApp = async () => {
	vi.resetModules();
	const { userPQStore } = await import('@/store/userPQ.store');
	const readCache = await import('@/lib/data/dialogCache');
	setActivePinia(createPinia());
	const store = userPQStore();
	await store.initialize();
	app = { store, readCache };
	return app;
};
const signIn = async (store: App['store'], who: Identity) => {
	await store.logout();
	await store.login(who.userHash);
};
const viewDialogOnline = async (dialogCache: DialogCacheModule, dialog: Dialog) => {
	const written = whenIdb('put', cacheKeysOf(dialog));
	for (const [table, rows] of Object.entries(dialog.tables)) {
		dialogCache.mirrorDialogTable({
			subscribeChanges: (cb, opts) => {
				if (opts?.includeInitialState) cb(Object.values(rows).map((value) => ({ key: collectionKeyFor(table as never, value), value, type: 'insert' })));
				return { unsubscribe() {} };
			},
		}, table as DialogCacheTable);
	}
	await written;
};
const mountChat = async (peer: Identity) => {
	HOLDER.peer = peer.userHash;
	const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
	return mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});
};

let dialog: Dialog;
beforeEach(async () => {
	dialog = await buildDialog();
});
afterEach(async () => {
	const { stopLeaderElection } = await import('@/lib/data/outbox');
	stopLeaderElection();
	app = null;
	globalThis.indexedDB = new IDBFactory();
});

describe('dialog read cache across a cold reload and sign-in', () => {
	it('restores the viewed dialog from IndexedDB after reload + offline sign-in, every row through admission', async () => {
		let { store, readCache } = await startApp();
		await signIn(store, A);
		await viewDialogOnline(readCache, dialog);

		({ store } = await startApp());
		expect(store.isAuthenticated).toBe(false);

		await signIn(store, A);
		expect(await readCacheKeys()).toEqual(cacheKeysOf(dialog));

		const wrapper = await mountChat(PEER);
		try {
			const bubble = (id: string) => wrapper.find(`[data-msg-id="${id}"]`);
			await vi.waitFor(() => expect(bubble(dialog.edited.message_id).find('.message-text').text()).toBe('history from disk'), { timeout: 8000 });
			await vi.waitFor(() => expect(bubble(dialog.edited.message_id).find('.msg-edited').text()).toContain('· 1'), { timeout: 8000 });
			await vi.waitFor(() => expect(bubble(dialog.tombstone.message_id).find('.message-text').text()).toContain('Message deleted'), { timeout: 8000 });
			await vi.waitFor(() => expect(bubble(dialog.forgedTombstone.message_id).find('.message-text').text()).toBe('Message failed verification'), { timeout: 8000 });
			await vi.waitFor(() => expect(bubble(dialog.edited.message_id).text()).toContain('👍'), { timeout: 8000 });
			expect(wrapper.text()).not.toContain('💀');
			expect(wrapper.text()).not.toContain('🔥');
			await vi.waitFor(() => expect(bubble(dialog.edited.message_id).find('.sync-status.acknowledged').exists()).toBe(true), { timeout: 8000 });
			const { useDialogsStore } = await import('@/store/dialogs.store');
			const $dialogs = useDialogsStore();
			expect(await $dialogs.admitReceiptRow(dialog.tables.dialog_message_receipts.forged)).toBe(false);
			expect(await $dialogs.admitReactionRow(dialog.forgedReaction)).toBe(false);
		} finally {
			wrapper.unmount();
		}
	}, 30_000);

	it('cold reload → sign-in as the same account keeps the dialog cache on disk', async () => {
		let { store, readCache } = await startApp();
		await signIn(store, A);
		await viewDialogOnline(readCache, dialog);

		({ store } = await startApp());
		const erased: string[] = [];
		const originalDelete = IDBObjectStore.prototype.delete;
		const originalClear = IDBObjectStore.prototype.clear;
		IDBObjectStore.prototype.delete = function (key) {
			erased.push(`${this.name}:${key}`);
			return originalDelete.call(this, key);
		};
		IDBObjectStore.prototype.clear = function () {
			erased.push(`${this.name}:*`);
			return originalClear.call(this);
		};
		try {
			await signIn(store, A);
			await readCacheKeys();
		} finally {
			IDBObjectStore.prototype.delete = originalDelete;
			IDBObjectStore.prototype.clear = originalClear;
		}

		expect(erased.filter((k) => k.startsWith('dialog_'))).toEqual([]);
		expect(await readCacheKeys()).toEqual(cacheKeysOf(dialog));
	}, 30_000);

	it('an explicit logout of the active account clears its dialog cache', async () => {
		const { store, readCache } = await startApp();
		await signIn(store, A);
		await viewDialogOnline(readCache, dialog);

		await store.logout();

		expect(await readCacheKeys()).toEqual([]);
	}, 30_000);

	it('switching A → B through the sign-in path clears A\'s dialog cache', async () => {
		const { store, readCache } = await startApp();
		await signIn(store, A);
		await viewDialogOnline(readCache, dialog);

		await signIn(store, B);

		expect(store.currentUserHash).toBe(B.userHash);
		expect(await readCacheKeys()).toEqual([]);
	}, 30_000);

	it('switching A → B by a direct login (no logout first) clears A\'s dialog cache too', async () => {
		const { store, readCache } = await startApp();
		await signIn(store, A);
		await viewDialogOnline(readCache, dialog);

		await store.login(B.userHash);

		expect(await readCacheKeys()).toEqual([]);
	}, 30_000);
});
