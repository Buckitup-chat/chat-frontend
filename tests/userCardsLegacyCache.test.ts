// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { watch } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { writeAsMain, mainStoreKeys, unpad } from './helpers/mainUserCache';
import type { UserCardRow } from '@/lib/data/types';
import type { userPQStore } from '@/store/userPQ.store';
import type { getUserCardsCollection } from '@/lib/data/collections';

type Store = ReturnType<typeof userPQStore>;
type IdbMethod = (...args: any[]) => IDBRequest;

const makeCard = (seed: number, name: string, extra: Partial<UserCardRow> = {}): UserCardRow => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactPk = secp.getPublicKey(new Uint8Array(32).fill(seed), true);
	const card = {
		user_hash: 'u_' + bytesToHex(sha3_512(sign.publicKey)),
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
		...extra,
	} as UserCardRow;
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return card;
};

const ALICE = makeCard(1, 'Alice');
const BOB = makeCard(2, 'Bob');
const CAROL = makeCard(3, 'Carol');
const ME = ALICE.user_hash;

const BINARY = ['sign_pkey', 'crypt_pkey', 'crypt_cert', 'contact_pkey', 'contact_cert', 'sign_b64'];

const whenIdb = (method: 'put' | 'delete', keys: string[]) => new Promise<void>((resolve) => {
	const pending = new Set(keys);
	const original: IdbMethod = IDBObjectStore.prototype[method];
	IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: any[]) {
		const request = original.apply(this, args);
		const key = method === 'put' ? (args[1] ?? args[0]?.__key) : args[0];
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
});

let vaultDisk: ReturnType<typeof freshVaultDisk>;
vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID }: { vaultID: string }) => vaultDisk.vaults.get(vaultID),
	rawStorage: () => ({
		async get(k: string) { return vaultDisk.raw.get(k); },
		async set(k: string, v: unknown) { vaultDisk.raw.set(k, v); },
		async remove(k: string) { vaultDisk.raw.delete(k); },
	}),
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
const freshVaultDisk = () => {
	const vault = new Map([['sign_skey', new Uint8Array(32).fill(7)], ['crypt_skey', new Uint8Array(32).fill(8)]]);
	return {
		raw: new Map<string, unknown>([['pq-vaults-registry', [{ user_hash: ME, vaultId: 'vault-me', name: 'Alice', crypt_pkey: ALICE.crypt_pkey }]]]),
		vaults: new Map([['vault-me', { id: 'vault-me', async get(k: string) { return vault.get(k); }, async set(k: string, v: Uint8Array) { vault.set(k, v); } }]]),
	};
};

const SCHEMA = JSON.stringify({
	user_hash: { type: 'text', pk_index: 0 },
	...Object.fromEntries(BINARY.map((c) => [c, { type: 'bytea' }])),
	name: { type: 'text' }, deleted_flag: { type: 'bool' }, owner_timestamp: { type: 'int8' },
});
const keyOf = (hash: string) => `"public"."user_cards"/"${hash}"`;
const insert = (card: UserCardRow) => ({ key: keyOf(card.user_hash), value: Object.fromEntries(Object.entries(unpad(card)).map(([k, v]) => [k, String(v)])), headers: { operation: 'insert' } });
const UP_TO_DATE = { headers: { control: 'up-to-date' } };
let offset = 0;
const response = (messages: unknown[], live: boolean) => new Response(JSON.stringify(messages), {
	status: 200,
	headers: {
		'content-type': 'application/json',
		'electric-handle': 'user-cards-handle',
		'electric-offset': `0_${++offset}`,
		'electric-up-to-date': '',
		...(live ? { 'electric-cursor': String(offset) } : { 'electric-schema': SCHEMA }),
	},
});
const held = (init?: Parameters<typeof fetch>[1]) => {
	let answer!: (value: Response) => void;
	const promise = new Promise<Response>((resolve, reject) => {
		answer = resolve;
		init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
	});
	return { promise, answer };
};
const network = {
	mode: 'offline', cards: [] as UserCardRow[], waiters: [] as (() => void)[], live: null as ReturnType<typeof held> | null,
	fetch: vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = new URL(String(input));
		if (network.mode === 'offline') throw new TypeError('Failed to fetch');
		if (network.mode === 'hanging' || url.searchParams.get('table') !== 'user_cards') return held(init).promise;
		if (url.searchParams.get('live') === 'true') {
			network.live = held(init);
			for (const w of network.waiters.splice(0)) w();
			return network.live.promise;
		}
		for (const w of network.waiters.splice(0)) w();
		return response([...network.cards.map(insert), UP_TO_DATE], false);
	}),
	nextRequest: () => new Promise<void>((resolve) => network.waiters.push(resolve)),
};

let app: { store: Store; coll: () => ReturnType<typeof getUserCardsCollection> } | null = null;
const startApp = async () => {
	vi.stubGlobal('fetch', network.fetch);
	vi.resetModules();
	const collections = await import('@/lib/data/collections');
	const { userPQStore } = await import('@/store/userPQ.store');
	setActivePinia(createPinia());
	const store = userPQStore();
	app = { store, coll: () => collections.getUserCardsCollection() };
	await store.initialize();
	return store;
};
const signIn = async (store: Store) => { await store.logout(); await store.login(ME); };
const reload = async () => { await app!.coll().cleanup(); app = null; };
const until = (getter: () => unknown) => new Promise((resolve) => {
	const stop = watch(getter, (v) => { if (v) { queueMicrotask(() => stop()); resolve(v); } }, { immediate: true });
});
const names = (store: Store) => store.allNetworkUsers.map((u: UserCardRow) => u.name);

beforeEach(() => {
	vaultDisk = freshVaultDisk();
	offset = 0;
});
afterEach(async () => {
	if (app) await reload();
	vi.unstubAllGlobals();
	globalThis.indexedDB = new IDBFactory();
});

describe('legacy compatibility: user-synced-cache written by main', () => {
	it('main\'s cached cards show offline after switching to this branch, then live replaces them', async () => {
		await writeAsMain([ALICE, BOB]);
		network.mode = 'offline';

		const store = await startApp();
		await signIn(store);
		await until(() => store.allNetworkUsers.length > 0);

		expect(names(store)).toEqual(['Alice', 'Bob']);
		expect(store.userCardsFallback).toBe(true);

		const request = network.nextRequest();
		network.mode = 'online';
		network.cards = [ALICE, CAROL];
		await request;
		await until(() => !store.userCardsFallback);
		expect(names(store)).toEqual(['Alice', 'Carol']);
		expect(store.getUserByHash(BOB.user_hash)).toBeUndefined();
	}, 30_000);

	it('a tampered or deleted card in main\'s store is not shown and not resolvable', async () => {
		await writeAsMain([ALICE, { ...BOB, name: 'Mallory' }, makeCard(3, 'Carol', { deleted_flag: true })]);
		network.mode = 'offline';

		const store = await startApp();
		await signIn(store);
		await until(() => store.allNetworkUsers.length > 0);

		expect(names(store)).toEqual(['Alice']);
		expect(store.getUserByHash(BOB.user_hash)).toBeUndefined();
		expect(store.getUserByHash(CAROL.user_hash)).toBeUndefined();
	}, 30_000);

	it('the cache is shown at startup, before the network answers at all', async () => {
		await writeAsMain([ALICE, BOB]);
		network.mode = 'hanging';

		const store = await startApp();
		await until(() => store.allNetworkUsers.length > 0);

		expect(names(store)).toEqual(['Alice', 'Bob']);
	}, 30_000);
});

describe('online session → reload → offline sign-in, through main\'s store', () => {
	it('live cards are mirrored into user-synced-cache/user_cards, survive sign-in and a reload, and show offline', async () => {
		network.mode = 'online';
		network.cards = [ALICE, BOB];
		const written = whenIdb('put', [ALICE.user_hash, BOB.user_hash]);
		let store = await startApp();
		await until(() => !store.userCardsFallback && store.allNetworkUsers.length === 2);
		await written;
		await signIn(store);
		expect(await mainStoreKeys()).toEqual([ALICE.user_hash, BOB.user_hash].sort());

		await reload();
		network.mode = 'offline';
		store = await startApp();
		await signIn(store);
		await until(() => store.allNetworkUsers.length > 0);
		expect(names(store)).toEqual(['Alice', 'Bob']);

		const request = network.nextRequest();
		network.mode = 'online';
		network.cards = [ALICE, CAROL];
		await request;
		await until(() => !store.userCardsFallback);
		expect(names(store)).toEqual(['Alice', 'Carol']);
	}, 30_000);

	it('a live deletion leaves the disk too: the card does not come back after an offline reload', async () => {
		network.mode = 'online';
		network.cards = [ALICE, BOB];
		const written = whenIdb('put', [ALICE.user_hash, BOB.user_hash]);
		let store = await startApp();
		await until(() => !store.userCardsFallback && store.allNetworkUsers.length === 2);
		await written;

		if (!network.live) await network.nextRequest();
		const removed = whenIdb('delete', [BOB.user_hash]);
		network.live!.answer(response([{ key: keyOf(BOB.user_hash), value: { user_hash: BOB.user_hash }, headers: { operation: 'delete' } }, UP_TO_DATE], true));
		await removed;
		await until(() => store.allNetworkUsers.length === 1);

		await reload();
		network.mode = 'offline';
		store = await startApp();
		await signIn(store);
		await until(() => store.allNetworkUsers.length > 0);
		expect(names(store)).toEqual(['Alice']);
	}, 30_000);
});
