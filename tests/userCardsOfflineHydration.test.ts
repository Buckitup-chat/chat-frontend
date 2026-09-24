// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { writeAsMain } from './helpers/mainUserCache';
import type { VueWrapper } from '@vue/test-utils';
import type { UserCardRow } from '@/lib/data/types';
import type { userPQStore } from '@/store/userPQ.store';
import type { getUserCardsCollection } from '@/lib/data/collections';

type Store = ReturnType<typeof userPQStore>;

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
const DAVE = makeCard(4, 'Dave');
const ME = 'u_' + 'f'.repeat(128);

const memoryStore = () => ({
	_map: new Map<string, string>(),
	async get(k: string) { return this._map.get(k) ?? null; },
	async set(k: string, v: string) { this._map.set(k, v); },
	async delete(k: string) { this._map.delete(k); },
	async keys() { return [...this._map.keys()]; },
	async clear() { this._map.clear(); },
});

const SCHEMA = JSON.stringify({
	user_hash: { type: 'text', pk_index: 0 }, sign_pkey: { type: 'text' }, crypt_pkey: { type: 'text' },
	crypt_cert: { type: 'text' }, contact_pkey: { type: 'text' }, contact_cert: { type: 'text' },
	name: { type: 'text' }, deleted_flag: { type: 'bool' }, owner_timestamp: { type: 'int8' }, sign_b64: { type: 'text' },
});
const wireValue = (card: UserCardRow) => Object.fromEntries(Object.entries(card).map(([k, v]) => [k, String(v)]));
const insert = (card: UserCardRow) => ({ key: `"public"."user_cards"/"${card.user_hash}"`, value: wireValue(card), headers: { operation: 'insert' } });
const UP_TO_DATE = { headers: { control: 'up-to-date' } };

let offset = 0;
const shapeResponse = (messages: unknown[], { live }: { live: boolean }) => new Response(JSON.stringify(messages), {
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

let server: ReturnType<typeof createServer>;
const createServer = (initial: string[]) => {
	const s = {
		requests: [] as { live: boolean }[],
		initial: [...initial],
		pendingInitial: null as ReturnType<typeof held> | null,
		pendingLive: null as ReturnType<typeof held> | null,
		fetch: vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = new URL(String(input));
			const live = url.searchParams.get('live') === 'true';
			s.requests.push({ live });
			if (live) {
				s.pendingLive = held(init);
				return s.pendingLive.promise;
			}
			const step = s.initial.shift() ?? 'hold';
			if (step === 'http400') return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
			if (step === 'network') throw new TypeError('Failed to fetch');
			s.pendingInitial = held(init);
			return s.pendingInitial.promise;
		}),
		async recover(cards: UserCardRow[]) {
			await vi.waitFor(() => expect(s.pendingInitial).not.toBeNull(), { timeout: 5000 });
			s.pendingInitial!.answer(shapeResponse([...cards.map(insert), UP_TO_DATE], { live: false }));
		},
		async pushLive(cards: UserCardRow[]) {
			await vi.waitFor(() => expect(s.pendingLive).not.toBeNull(), { timeout: 5000 });
			const pending = s.pendingLive;
			s.pendingLive = null;
			pending!.answer(shapeResponse([...cards.map(insert), UP_TO_DATE], { live: true }));
		},
	};
	return s;
};

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			isAuth: true,
			currentUserHash: ME,
			initialize: async () => {},
			getLocalUserCards: async () => [],
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	},
}));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ alertingPeers: new Set(), checkpointAlerts: new Map(), scanCheckpointAlerts: () => {} }),
}));
vi.mock('@/store/transfers.store', () => ({
	useTransfersStore: () => ({ transferPeers: new Set() }),
}));

let app: { store: Store; readCache: typeof import('@/lib/data/readCache'); coll: () => ReturnType<typeof getUserCardsCollection> } | null;
const boot = async (initialSteps: string[], cached: UserCardRow[] = []) => {
	server = createServer(initialSteps);
	vi.stubGlobal('fetch', server.fetch);
	vi.resetModules();
	const readCache = await import('@/lib/data/readCache');
	readCache._setReadCacheStorageForTests(memoryStore());
	(await import('@/lib/data/outbox'))._setStorageForTests(memoryStore());
	(await import('@/lib/data/intents'))._setIntentStorageForTests(memoryStore());
	await writeAsMain(cached);
	const collections = await import('@/lib/data/collections');
	const { userPQStore } = await import('@/store/userPQ.store');
	setActivePinia(createPinia());
	const store = userPQStore();
	store.isOnline = true;
	app = { store, readCache, coll: () => collections.getUserCardsCollection() };
	return app;
};
const names = (store: Store) => store.allNetworkUsers.map((u: UserCardRow) => u.name);

beforeEach(() => { offset = 0; });
afterEach(async () => {
	await app?.coll().cleanup();
	app = null;
	vi.unstubAllGlobals();
	globalThis.indexedDB = new IDBFactory();
});

describe('user_cards offline reload: ShapeStream onError → ready → resolved empty preload', () => {
	it('shows the cached, verified cards at once, then the live set replaces them without remount', async () => {
		const { store, coll } = await boot(['http400', 'hold'], [ALICE, BOB]);

		await store.initialize();

		await coll().preload();
		expect(coll().status).toBe('ready');
		expect(coll().toArray).toEqual([]);

		await vi.waitFor(() => expect(names(store)).toEqual(['Alice', 'Bob']));
		expect(store.userCardsFallback).toBe(true);
		expect(server.requests.filter((r) => !r.live)).toHaveLength(1);

		await server.recover([ALICE, CAROL]);

		await vi.waitFor(() => expect(store.userCardsFallback).toBe(false));
		expect(names(store)).toEqual(['Alice', 'Carol']);
		expect(store.getUserByHash(BOB.user_hash)).toBeUndefined();
	});

	it('a cache-only card stays gone across the next live update', async () => {
		const { store } = await boot(['http400', 'hold'], [ALICE, BOB]);
		await store.initialize();
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(true));
		await server.recover([ALICE]);
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(false));

		await server.pushLive([DAVE]);

		await vi.waitFor(() => expect(names(store)).toEqual(['Alice', 'Dave']));
	});

	it('tampered, deleted and this-session-touched cached cards are neither listed nor resolvable', async () => {
		const deletedCarol = makeCard(3, 'Carol', { deleted_flag: true });
		await writeAsMain([ALICE, { ...BOB, name: 'Mallory' } , deletedCarol, DAVE]);
		const { store, readCache } = await boot(['http400', 'hold']);
		readCache.markTouched('user_cards', DAVE.user_hash);

		await store.initialize();
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(true));

		expect(names(store)).toEqual(['Alice']);
		expect(store.getUserByHash(BOB.user_hash)).toBeUndefined();
		expect(store.getUserByHash(CAROL.user_hash)).toBeUndefined();
		expect(store.getUserByHash(DAVE.user_hash)).toBeUndefined();
	});

	it('an empty cache ends hydration honestly instead of claiming an empty network list', async () => {
		const { store } = await boot(['http400', 'hold']);
		await store.initialize();
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(true));

		const MenuUsers = (await import('@/views/menu/views/Menu_Users.vue')).default;
		const w = mount(MenuUsers, {
			global: { provide: { $route: { params: {} }, $router: { push: () => {} } }, stubs: { Users_List: true } },
		});
		expect(store.allNetworkUsers).toEqual([]);
		expect(w.text()).toContain('No cached users available offline');
		expect(w.text()).not.toContain('Network users list is empty');
	});
});

describe('user_cards offline reload: network error (never reaches onError, preload stays pending)', () => {
	it('shows the cached cards while preload is still pending, then attaches on up-to-date', async () => {
		const { store, coll } = await boot(['network', 'hold'], [ALICE, BOB]);

		await store.initialize();

		await vi.waitFor(() => expect(names(store)).toEqual(['Alice', 'Bob']));
		expect(coll().status).not.toBe('ready');

		await server.recover([ALICE, CAROL]);
		await vi.waitFor(() => expect(names(store)).toEqual(['Alice', 'Carol']));
		expect(store.userCardsFallback).toBe(false);
	});
});

describe('warm live rows outrank the cache', () => {
	it('a row the collection already holds wins over its stale cached copy', async () => {
		await writeAsMain([makeCard(1, 'Alice (stale)'), BOB]);
		await boot([]);
		const { userCardsWithCache } = await import('@/lib/data/userCardsLink');

		const rows = await userCardsWithCache([ALICE]);

		expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
	});
});

describe('global chip on the user_cards cache fallback', () => {
	const chipText = (w: VueWrapper) => w.find('.sync-status .status-text').text();
	const mountList = async () => {
		const UserList = (await import('@/components/UserList.vue')).default;
		return mount(UserList, { props: { selected: [] }, global: { stubs: { Account_Item_PQ: true } } });
	};

	it('backend unavailable, browser online: Syncing; confirmed live recovery: Synced', async () => {
		const { store } = await boot(['http400', 'hold'], [ALICE]);
		await store.initialize();
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(true));
		const w = await mountList();

		await vi.waitFor(() => expect(chipText(w)).toBe('Syncing'));

		await server.recover([ALICE]);
		await vi.waitFor(() => expect(chipText(w)).toBe('Synced'));
	});

	it('real browser offline: Offline', async () => {
		const { store } = await boot(['network', 'hold'], [ALICE]);
		store.isOnline = false;
		await store.initialize();
		await vi.waitFor(() => expect(store.userCardsFallback).toBe(true));
		const w = await mountList();

		await vi.waitFor(() => expect(chipText(w)).toBe('Offline'));
	});
});
