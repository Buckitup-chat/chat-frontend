import { IDBFactory } from 'fake-indexeddb';
import { vi, expect } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { Mock } from 'vitest';
import type {
	UserCardRow, UserStorageRow, DialogKeyRow, DialogMessageRow, DialogMessageVersionRow,
	DialogMessageReactionRow, DialogMessageReceiptRow, IngestRowResult,
} from '@/lib/data/types';

export type RowOf = {
	user_cards: UserCardRow;
	user_storage: UserStorageRow;
	dialog_keys: DialogKeyRow;
	dialog_messages: DialogMessageRow;
	dialog_messages_versions: DialogMessageVersionRow;
	dialog_message_reactions: DialogMessageReactionRow;
	dialog_message_receipts: DialogMessageReceiptRow;
};
export type Relation = keyof RowOf;
export type Row = RowOf[Relation];
export type ApplyResult = Omit<IngestRowResult, 'index'> & { permanent422?: boolean };
export type ServerPost = { relation: Relation; row: Row; result: ApplyResult };
type FetchArgs = Parameters<typeof fetch>;
export type RowListener = (relation: Relation, row: Row) => void;

export interface Server {
	tables: Map<Relation, Map<string, Row>>;
	posts: ServerPost[];
	listeners: Set<RowListener>;
	held: Map<Relation, Set<string>>;
	reject: ((relation: Relation, row: Row) => ApplyResult | null | undefined) | null;
	reset(): void;
	hold(relation: Relation): void;
	release(relation: Relation): void;
	isHidden(relation: Relation, row: Row): boolean;
	table<R extends Relation>(relation: R): Map<string, RowOf[R]>;
	apply(relation: Relation, type: string, row: Row): ApplyResult;
	fetch: Mock<(input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>>;
}

export type NetMode = 'online' | 'offline' | 'offline-warm' | 'error-ready';

export type Vault = {
	id: string;
	get(k: string): Promise<unknown>;
	set(k: string, v: unknown): Promise<void>;
	clear(): Promise<void>;
};
export type VaultDisk = { vaults: Map<string, Vault>; raw: Map<string, unknown> };

export type App = {
	store: ReturnType<typeof import('@/store/userPQ.store').userPQStore>;
	$dialogs: ReturnType<typeof import('@/store/dialogs.store').useDialogsStore>;
	outbox: typeof import('@/lib/data/outbox');
	wrapper: VueWrapper | null;
};
export type Client = { name: string; idb: IDBFactory; vault: VaultDisk; hash: string; app: App };

export type SwalCall = Record<string, unknown>;

export type ViewChange = { type: string; key: string; value: Row };
type ChangeListener = (changes: ViewChange[]) => void;
type UpToDateMatcher = { fn: (message: unknown) => boolean; resolve: (matched: boolean) => void };

type Globals = {
	net?: { mode: NetMode };
	server?: Server;
	reconnects?: Set<() => void>;
	vaultState?: { current: VaultDisk | null };
	route?: { peer: string };
	swal?: { calls: SwalCall[] };
	clients?: { active: Client | null };
};

export const PK: { [R in Relation]: (r: RowOf[R]) => string } = {
	user_cards: (r) => r.user_hash,
	user_storage: (r) => `${r.user_hash}|${r.uuid}`,
	dialog_keys: (r) => `${r.dialog_hash}|${r.sender_hash}`,
	dialog_messages: (r) => r.message_id,
	dialog_messages_versions: (r) => `${r.message_id}|${r.sign_hash}`,
	dialog_message_reactions: (r) => r.reaction_hash,
	dialog_message_receipts: (r) => r.receipt_hash,
};

const G = ((globalThis as { __twoClients?: Globals }).__twoClients ??= {});

export const net = (G.net ??= { mode: 'online' });

export const server = (G.server ??= {
	tables: new Map(),
	posts: [],
	listeners: new Set(),
	held: new Map(),
	reject: null,
	reset() { this.tables = new Map(); this.posts = []; this.listeners = new Set(); this.held = new Map(); this.reject = null; },
	hold(relation) { if (!this.held.has(relation)) this.held.set(relation, new Set()); },
	release(relation) {
		const keys = this.held.get(relation);
		this.held.delete(relation);
		for (const key of keys ?? []) {
			const row = this.table(relation).get(key);
			if (row) for (const l of this.listeners) l(relation, row);
		}
	},
	isHidden(relation, row) { return this.held.get(relation)?.has(PK[relation](row as never)) ?? false; },
	table(relation) {
		if (!this.tables.has(relation)) this.tables.set(relation, new Map());
		return this.tables.get(relation) as never;
	},
	apply(relation, type, row) {
		const table = this.table(relation);
		const key = PK[relation](row as never);
		const stored = table.get(key);
		let result: ApplyResult;
		const rejection = this.reject?.(relation, row);
		if (rejection) {
			result = rejection;
		} else if (type === 'insert' && stored) {
			result = { status: 'exists', conflicted: stored.sign_b64 !== row.sign_b64 };
		} else if (type === 'update' && stored && Number(row.owner_timestamp) <= Number(stored.owner_timestamp)) {
			result = { status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } };
		} else {
			const archived = relation === 'dialog_messages' && stored ? stored : null;
			if (archived) this.table('dialog_messages_versions').set(PK.dialog_messages_versions(archived as DialogMessageVersionRow), archived as DialogMessageVersionRow);
			table.set(key, row);
			result = { status: 'ok', txid: this.posts.length + 1 };
			if (archived) for (const l of this.listeners) l('dialog_messages_versions', archived);
		}
		this.posts.push({ relation, row, result });
		if (result.status === 'ok' && this.held.has(relation)) { this.held.get(relation)!.add(key); return result; }
		if (result.status === 'ok') for (const l of this.listeners) l(relation, row);
		return result;
	},
	fetch: vi.fn(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
		const url = String(input);
		if (net.mode === 'offline') throw new TypeError('Failed to fetch');
		if (url.endsWith('/challenge')) return Response.json({ challenge: 'c', challenge_id: 'id' });
		if (!url.endsWith('/ingest_each')) throw new TypeError(`unexpected request ${url}`);
		const { mutations } = JSON.parse(init!.body as string);
		const results: (ApplyResult & { index: number })[] = mutations.map((m: { syncMetadata: { relation: Relation }; type: string; modified?: Row; changes: Row }, index: number) => ({ index, ...server.apply(m.syncMetadata.relation, m.type, m.modified ?? m.changes) }));
		return Response.json({ results }, { status: results.some((r) => r.permanent422) ? 422 : 200 });
	}),
});

const reconnects = (G.reconnects ??= new Set());
export const goOnline = () => {
	net.mode = 'online';
	for (const r of [...reconnects]) r();
};

const view = (relation: Relation, scope: (r: Row) => boolean = () => true, report: () => void = () => {}) => {
	const listeners = new Set<ChangeListener>();
	const matchers = new Set<UpToDateMatcher>();
	const preloads = new Set<() => void>();
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		if (net.mode !== 'online') report();
	};
	const rowsNow = () => [...server.table(relation).values()].filter((r) => scope(r) && !server.isHidden(relation, r));
	const hasRows = () => net.mode === 'online' || net.mode === 'offline-warm';
	const upToDate = () => {
		for (const m of [...matchers]) if (m.fn({ headers: { control: 'up-to-date' } })) { matchers.delete(m); m.resolve(true); }
		for (const p of [...preloads]) { preloads.delete(p); p(); }
	};
	server.listeners.add((rel, row) => {
		if (net.mode === 'online' && rel === relation && scope(row)) for (const cb of listeners) cb([{ type: 'insert', key: PK[relation](row as never), value: row }]);
	});
	reconnects.add(() => {
		for (const cb of listeners) cb(rowsNow().map((value) => ({ type: 'insert', key: PK[relation](value as never), value })));
		upToDate();
	});
	return {
		preload(): Promise<void> {
			start();
			if (net.mode === 'online') return Promise.resolve();
			if (net.mode === 'error-ready') return Promise.resolve();
			return new Promise((resolve) => preloads.add(resolve));
		},
		get(key: string) {
			if (!hasRows()) return undefined;
			const row = server.table(relation).get(key);
			return row && scope(row) && !server.isHidden(relation, row) ? row : undefined;
		},
		get toArray() { return hasRows() ? rowsNow() : []; },
		subscribeChanges(cb: ChangeListener, opts?: { includeInitialState?: boolean }) {
			listeners.add(cb);
			start();
			if (opts?.includeInitialState && hasRows()) cb(this.toArray.map((value) => ({ type: 'insert', key: PK[relation](value as never), value })));
			return { unsubscribe: () => listeners.delete(cb) };
		},
		utils: {
			awaitMatch(fn: (message: unknown) => boolean, _timeout?: number): Promise<boolean> {
				if (net.mode === 'online' && fn({ headers: { control: 'up-to-date' } })) return Promise.resolve(true);
				return new Promise((resolve) => matchers.add({ fn, resolve }));
			},
		},
	};
};

export const DIALOG_TABLE = {
	keys: 'dialog_keys', messages: 'dialog_messages', versions: 'dialog_messages_versions',
	reactions: 'dialog_message_reactions', receipts: 'dialog_message_receipts',
} as const;
type DialogTableKey = keyof typeof DIALOG_TABLE;

export type View = ReturnType<typeof view>;
export type DialogViews = Record<DialogTableKey, View>;

export const createCollectionsModule = async () => {
	const { mirrorDialogTable } = await import('@/lib/data/dialogCache');
	const { mirrorUserCards } = await import('@/lib/data/userCardsCache');
	const { createShapeLink, registerShapeLink } = await import('@/lib/data/shapeLink');
	const userCardsLink = await import('@/lib/data/userCardsLink');
	const cards = view('user_cards', () => true, () => userCardsLink.reportUserCardsStreamError());
	registerShapeLink(cards, userCardsLink.userCardsShapeLink);
	mirrorUserCards(cards);
	const storage = new Map<string, View>();
	const dialogs = new Map<string, DialogViews>();
	const dialogFor = (dialogHash: string) => {
		if (!dialogs.has(dialogHash)) {
			const inDialog = (r: Row) => r.dialog_hash === dialogHash;
			const colls = {} as DialogViews;
			for (const [k, t] of Object.entries(DIALOG_TABLE) as [DialogTableKey, (typeof DIALOG_TABLE)[DialogTableKey]][]) {
				const link = createShapeLink();
				colls[k] = view(t, inDialog, () => link.report());
				registerShapeLink(colls[k], link);
			}
			for (const [k, t] of Object.entries(DIALOG_TABLE) as [DialogTableKey, (typeof DIALOG_TABLE)[DialogTableKey]][]) mirrorDialogTable(colls[k], t);
			dialogs.set(dialogHash, colls);
		}
		return dialogs.get(dialogHash)!;
	};
	return {
		getUserCardsCollection: () => cards,
		getUserStorageCollection: (userHash: string) => {
			if (!storage.has(userHash)) storage.set(userHash, view('user_storage', (r) => r.user_hash === userHash));
			return storage.get(userHash);
		},
		resetUserStorageCollection: () => {},
		getDialogCollections: dialogFor,
		withDialogCollections: async <T>(dialogHash: string, read: (colls: DialogViews) => T) => read(dialogFor(dialogHash)),
		isDialogWarm: () => true,
		releaseDialogCollections: () => {},
	};
};

export const vaultState = (G.vaultState ??= { current: null });
export const vaultModule = {
	connect: async ({ vaultID, addNewVault }: { vaultID: string; addNewVault?: boolean }) => {
		const disk = vaultState.current!;
		if (addNewVault) {
			const id = `vault-${disk.vaults.size + 1}`;
			const data = new Map();
			disk.vaults.set(id, { id, async get(k) { return data.get(k); }, async set(k, v) { data.set(k, v); }, async clear() { data.clear(); } });
			return disk.vaults.get(id);
		}
		return disk.vaults.get(vaultID);
	},
	rawStorage: () => ({
		async get(k: string) { return vaultState.current!.raw.get(k); },
		async set(k: string, v: unknown) { vaultState.current!.raw.set(k, v); },
		async remove(k: string) { vaultState.current!.raw.delete(k); },
	}),
};

export const route = (G.route ??= { peer: '' });
export const swal = (G.swal ??= { calls: [] });

export const newClient = (name: string): Client => ({ name, idb: new IDBFactory(), vault: { vaults: new Map(), raw: new Map() }, hash: null as never, app: null as never });

const clients = (G.clients ??= { active: null });
export const startApp = async (client: Client) => {
	clients.active?.app?.wrapper?.unmount();
	if (clients.active?.app?.outbox) clients.active.app.outbox.stopLeaderElection();
	globalThis.indexedDB = client.idb;
	vaultState.current = client.vault;
	vi.stubGlobal('fetch', server.fetch);
	server.listeners = new Set();
	reconnects.clear();
	vi.resetModules();
	vi.doMock('@/lib/data/collections', () => createCollectionsModule());
	const outbox = await import('@/lib/data/outbox');
	outbox._setLeaderForTests(true);
	const { userPQStore } = await import('@/store/userPQ.store');
	setActivePinia(createPinia());
	const store = userPQStore();
	await store.initialize();
	const { useDialogsStore } = await import('@/store/dialogs.store');
	client.app = { store, $dialogs: useDialogsStore(), outbox, wrapper: null };
	clients.active = client;
	return client.app;
};
export const register = async (client: Client) => {
	const { store } = await startApp(client);
	await store.registerNewUser({ name: client.name } as never);
	client.hash = store.currentUserHash as unknown as string;
	return client.app;
};
export const signIn = async (client: Client) => {
	await client.app.store.logout();
	await client.app.store.login(client.hash);
};
export const openChat = async (client: Client, peer: Client) => {
	route.peer = peer.hash;
	const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
	client.app.wrapper = mount(PageChat, {
		global: {
			provide: { $swal: { fire: async (opts: SwalCall) => { swal.calls.push(opts); return {}; } } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});
	return client.app.wrapper;
};
export const closeChat = (client: Client) => { client.app?.wrapper?.unmount(); if (client.app) client.app.wrapper = null; };
export const stopAll = () => {
	clients.active?.app?.wrapper?.unmount();
	clients.active?.app?.outbox?.stopLeaderElection();
	clients.active = null;
	vi.unstubAllGlobals();
};

export const feedOf = (wrapper: VueWrapper) => wrapper.findAll('.message-bubble').map((b) => ({
	id: b.attributes('data-msg-id'),
	text: b.find('.message-text').text(),
	waiting: b.find('.msg-unplaced-note').exists(),
	blocked: b.find('.msg-blocked-note').exists(),
}));
export const expectVerifiedFeed = (wrapper: VueWrapper, texts: string[]) => {
	const feed = feedOf(wrapper);
	expect(feed.map((e) => e.text)).toEqual(texts);
	expect(feed.filter((e) => e.waiting || e.blocked)).toEqual([]);
	expect(wrapper.text()).not.toContain('Message failed verification');
};
