import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;
type Mutation = { type: string; modified?: Row; changes?: Row; original?: Row; syncMetadata: { relation: string } };

const makeStore = (name: string, log: string[]) => {
	const map = new Map<string, string>();
	const store = {
		map,
		failSet: null as null | ((key: string, value: string) => boolean),
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) {
			if (store.failSet?.(k, v)) throw new Error(`${name} storage down`);
			map.set(k, v);
			log.push(`${name}:${k}`);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
	return store;
};

const makeVault = (id: string) => {
	const data = new Map<string, unknown>();
	return { id, async set(k: string, v: unknown) { data.set(k, v); }, async get(k: string) { return data.get(k); } };
};

let events: string[];
let vaults: Map<string, ReturnType<typeof makeVault>>;
let rawStore: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> };
let cardRows: Map<string, Row>;
let intentStore: ReturnType<typeof makeStore>;
let outboxStore: ReturnType<typeof makeStore>;
let httpSent: Mutation[][];
let networkDown: (mutations: Mutation[]) => boolean;
let hangs: (mutations: Mutation[]) => boolean;
const hanging: Array<(e: Error) => void> = [];
let rejects: (mutations: Mutation[]) => boolean;
let cardSignatures: number;
let signingFails: boolean;
let acceptedStore: ReturnType<typeof makeStore>;
let onHttp: ((mutations: Mutation[]) => void) | null;

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }: { vaultID?: string; addNewVault?: boolean }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID as string);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('@/lib/data/readSession', () => ({
	bearerFor: () => '',
	hasValidToken: () => false,
	handleShapeAuth401: async () => false,
	openSession: async () => null,
	invalidateSession: () => {},
	clearSessions: () => {},
}));
vi.mock('@/lib/data/accessGate', () => ({
	markShapeBlocked: () => {},
	markShapeUnblocked: () => {},
	isShapeBlocked: () => false,
	hasBlockedShapes: () => false,
	blockedShapeNames: () => [],
	onBlockedChange: () => () => {},
	setWriteProber: () => {},
	syncBlockedWrites: () => {},
	waitForUnblock: async () => {},
	probeAllBlocked: () => {},
	resetGate: () => {},
}));

let linkedCards: object | null = null;
vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => linkedCards ?? ({
		async preload() {},
		get: (k: string) => cardRows.get(k),
		get toArray() { return [...cardRows.values()]; },
	}),
}));

vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => {
		events.push('user_storage');
		return { sync: Promise.resolve({ status: 'synced' }) };
	},
	saveStorageJsonPatch: async () => {
		events.push('user_storage');
		return 'synced';
	},
}));

vi.mock('@/api/client', async () => {
	const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
	return {
		api: {
			...actual.api,
			createUserCard: (...args: Parameters<typeof actual.api.createUserCard>) => {
				if (signingFails) throw new Error('signing unavailable');
				const signed = actual.api.createUserCard(...args);
				cardSignatures++;
				events.push('sign:user_cards');
				return signed;
			},
			ingestWithAuthEach: async (mutations: Mutation[]) => {
				const registry = ((await rawStore.get('pq-vaults-registry')) ?? []) as Array<{ user_hash: string }>;
				const owners = new Set(registry.map((identity) => identity.user_hash));
				if (!mutations.every((m) => owners.has((m.modified ?? m.changes)?.user_hash as string))) {
					throw new TypeError('Failed to fetch: traffic of a finished test');
				}
				onHttp?.(mutations);
				events.push(`http:${mutations.map((m) => m.syncMetadata.relation).join(',')}`);
				if (hangs(mutations)) return new Promise<Response>((_, reject) => { hanging.push(reject); });
				if (rejects(mutations)) {
					return {
						status: 422,
						json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed' })) }),
					} as unknown as Response;
				}
				if (networkDown(mutations)) throw new TypeError('Failed to fetch');
				httpSent.push(mutations);
				return {
					status: 200,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
				} as unknown as Response;
			},
		},
	};
});

vi.mock('@/lib/data/intentRecovery', async () => {
	const actual = await vi.importActual<typeof import('@/lib/data/intentRecovery')>('@/lib/data/intentRecovery');
	return {
		...actual,
		recoverIntents: (...args: Parameters<typeof actual.recoverIntents>) => {
			events.push('recoverIntents');
			return actual.recoverIntents(...args);
		},
	};
});

const { EncryptionManagerPQ, AccountImportIncompleteError, LoginDeferredError } = await import('@/libs/EncryptionManagerPQ');
const { DecryptFailedError } = await import('@/lib/data/secureStore');
const intents = await import('@/lib/data/intents');
const outbox = await import('@/lib/data/outbox');
const ingest = await import('@/lib/data/ingest');
const intentRecovery = await import('@/lib/data/intentRecovery');
const { publishUserCard, storeUserCardIntent, withCardLock, CardAuthoringBlockedError, BootstrapCardRejectedError } = await import('@/lib/data/userCardIntent');
const { getAccepted, _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { createShapeLink, registerShapeLink, whenLive } = await import('@/lib/data/shapeLink');

interface Manager {
	createUserVault(opts: { name: string }): Promise<{ user_hash: string }>;
	updateOwnUserCardName(name: string): Promise<unknown>;
	pushCurrentUserCard(): Promise<unknown>;
	updateUserStorage(opts: { name?: string }): Promise<unknown>;
	getLocalUserCards(): Promise<Array<Row & { user_hash: string; name: string }>>;
	login(userHash: string): Promise<unknown>;
	logout(): Promise<void>;
	exportVaultKeys(): Promise<{ sign_skey: string }>;
	importVaultKeys(keys: unknown, identity: Row): Promise<{ status: string; userHash: string }>;
	isAuth: boolean;
	currentUserHash: string | null;
	localStorageOwnerHash: string | null;
	addEventListener(type: string, fn: (e: Event) => void): void;
}

const freshManager = (): Manager => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance() as unknown as Manager;
};

const rowOf = (m: Mutation): Row => (m.modified ?? m.changes)!;
const parsed = (values: Iterable<string>) => [...values].flatMap((v) => {
	try {
		return [JSON.parse(v)];
	} catch {
		return [];
	}
});
const cardEntries = () => parsed([...outboxStore.map.entries()].filter(([k]) => !k.includes('|')).map(([, v]) => v))
	.filter((e) => e.relation === 'user_cards');
const cardIntents = () => parsed(intentStore.map.values()).filter((e) => e.relation === 'user_cards');
const acceptedCardOf = (userHash: string): Row => rowOf(httpSent.flat().find((m) => m.type === 'insert' && m.syncMetadata.relation === 'user_cards' && rowOf(m).user_hash === userHash)!);
const signKeyOf = async (em: Manager) => Uint8Array.from(atob((await em.exportVaultKeys()).sign_skey), (c) => c.charCodeAt(0));

const snapshotsAtHttp: Array<{ stored: boolean; intentLinked: boolean }> = [];
const checkSnapshotAtHttp = (mutations: Mutation[]) => {
	for (const m of mutations) {
		if (m.syncMetadata.relation !== 'user_cards') continue;
		const entry = cardEntries().find((e) => JSON.stringify(e.mutations[0]) === JSON.stringify(m));
		const intent = entry && cardIntents().find((i) => i.intent.ref === entry.id || JSON.stringify(i.intent.signedMutation) === JSON.stringify(m));
		snapshotsAtHttp.push({ stored: !!entry, intentLinked: !!intent });
	}
};

beforeEach(() => {
	linkedCards = null;
	events = [];
	vaults = new Map();
	cardRows = new Map();
	httpSent = [];
	cardSignatures = 0;
	signingFails = false;
	networkDown = () => false;
	hangs = () => false;
	rejects = () => false;
	snapshotsAtHttp.length = 0;
	onHttp = checkSnapshotAtHttp;
	const raw = new Map<string, unknown>();
	rawStore = {
		async get(k) { return raw.get(k); },
		async set(k, v) { raw.set(k, v); },
		async remove(k) { raw.delete(k); },
	};
	intentStore = makeStore('intent', events);
	outboxStore = makeStore('outbox', events);
	intents._setIntentStorageForTests(intentStore);
	outbox._setStorageForTests(outboxStore);
	acceptedStore = makeStore('accepted', []);
	_setAcceptedSnapshotStorageForTests(acceptedStore);
	outbox._setLeaderForTests(true);
});

afterEach(async () => {
	for (const fail of hanging.splice(0)) fail(new TypeError('the crashed process is gone'));
	outbox.stopDrainLoop();
	await outbox._drainLoopSettledForTests();
	outbox._setLeaderForTests(null);
	onHttp = null;
});

const reloadApp = async ({ afterSession = true } = {}) => {
	if (afterSession) await vi.waitFor(() => expect(events).toContain('recoverIntents'));
	outbox.stopDrainLoop();
	await Promise.all([import('@/lib/data/messageIntent'), import('@/lib/data/storageIntent')]);
	vi.resetModules();
	const app = {
		EM: (await import('@/libs/EncryptionManagerPQ')).EncryptionManagerPQ,
		outbox: await import('@/lib/data/outbox'),
	};
	(await import('@/lib/data/intents'))._setIntentStorageForTests(intentStore);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStore('accepted', []));
	app.outbox._setStorageForTests(outboxStore);
	app.outbox._setLeaderForTests(true);
	app.EM.instance = null;
	return { ...app, manager: app.EM.getInstance() as unknown as Manager };
};

const at = (prefix: string) => events.findIndex((e) => e.startsWith(prefix));

describe('one durable intent and one exact signed snapshot before any HTTP', () => {
	it('insert (registration): intent, signature, stored snapshot, then HTTP — in that order', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });

		const [intent] = cardIntents();
		const [entry] = cardEntries();
		expect(intent).toBeTruthy();
		expect(intent.intent).toMatchObject({ resolved: true, ref: entry.id });
		expect(httpSent.flat().map((m) => m.type)).toEqual(['insert']);
		expect(at(`intent:${intent.id}`)).toBeLessThan(at('sign:user_cards'));
		expect(at('sign:user_cards')).toBeLessThan(at(`outbox:${entry.id}`));
		expect(at(`outbox:${entry.id}`)).toBeLessThan(at('http:user_cards'));
		expect(snapshotsAtHttp).toEqual([{ stored: true, intentLinked: true }]);
		expect(cardSignatures).toBe(1);
	});

	it('update: the same order, as its own intent and snapshot', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		events.length = 0;
		snapshotsAtHttp.length = 0;

		await em.updateOwnUserCardName('Renamed');

		const update = cardEntries().at(-1);
		const updateIntent = cardIntents().find((i) => i.intent.ref === update.id);
		expect(httpSent.flat().at(-1)!.type).toBe('update');
		expect(updateIntent).toBeTruthy();
		expect(at(`intent:${updateIntent.id}`)).toBeLessThan(at('sign:user_cards'));
		expect(at(`outbox:${update.id}`)).toBeLessThan(at('http:user_cards'));
		expect(snapshotsAtHttp).toEqual([{ stored: true, intentLinked: true }]);
	});

	it('the production callers — pushCurrentUserCard, rename and profile update — all go through the durable path', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		snapshotsAtHttp.length = 0;

		await em.pushCurrentUserCard();
		await em.updateOwnUserCardName('Renamed');
		await em.updateUserStorage({ name: 'Profile name' });

		expect(snapshotsAtHttp).toEqual([
			{ stored: true, intentLinked: true },
			{ stored: true, intentLinked: true },
			{ stored: true, intentLinked: true },
		]);
		expect(cardIntents()).toHaveLength(4);
		expect(cardEntries()).toHaveLength(4);
		expect(httpSent.flat().map((m) => m.type)).toEqual(['insert', 'update', 'update', 'update']);
		expect(rowOf(httpSent.at(-1)![0]).name).toBe('Profile name');
	});

	it('importing an account publishes its card through the durable path too, inside the imported account\'s session', async () => {
		const source = freshManager();
		await source.createUserVault({ name: 'Imported' });
		const keys = await source.exportVaultKeys();
		const identity = { ...(await source.getLocalUserCards())[0] };
		await source.logout();
		await newDevice();
		snapshotsAtHttp.length = 0;

		const target = freshManager();
		const result = await target.importVaultKeys(keys, identity);

		expect(result).toEqual({ status: 'active', userHash: identity.user_hash });
		expect(target.isAuth).toBe(true);
		expect(snapshotsAtHttp).toEqual([{ stored: true, intentLinked: true }]);
		expect(rowOf(httpSent.at(-1)![0])).toMatchObject({ user_hash: identity.user_hash, name: 'Imported' });
	});

	it('registration: the card is accepted by the server before the dependent user_storage write starts', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });

		expect(at('http:user_cards')).toBeGreaterThanOrEqual(0);
		expect(at('http:user_cards')).toBeLessThan(at('user_storage'));
	});
});

describe('profile edits publish the card through the one durable path, with the offline semantics of a profile save', () => {
	const updatesSent = () => httpSent.flat().filter((m) => m.syncMetadata.relation === 'user_cards' && m.type === 'update');
	const counts = () => ({ intents: cardIntents().length, entries: cardEntries().length, signatures: cardSignatures, requests: events.filter((e) => e === 'http:user_cards').length });
	const cardWritesSettled = (userHash: string) => withCardLock(userHash, async () => {});

	it('offline, a profile edit stores one card write, reports pending, and the outbox later sends that exact snapshot', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const before = counts();
		const attempted: Mutation[] = [];
		onHttp = (m) => { checkSnapshotAtHttp(m); attempted.push(...m.filter((x) => x.syncMetadata.relation === 'user_cards')); };
		networkDown = () => true;

		const saved = await em.updateUserStorage({ name: 'Offline name' });

		expect(saved).toMatchObject({ pending: true, cardPublished: true });
		expect(counts()).toMatchObject({ intents: before.intents + 1, entries: before.entries + 1, signatures: before.signatures + 1 });
		const stored = cardEntries().at(-1);
		expect(stored.mutations[0].type).toBe('update');
		expect(attempted).toEqual([stored.mutations[0]]);
		expect(updatesSent()).toEqual([]);

		networkDown = () => false;
		ingest.resumePendingWrites(userHash, await signKeyOf(em));
		await vi.waitFor(() => expect(updatesSent()).toHaveLength(1));

		expect(updatesSent()).toEqual([stored.mutations[0]]);
		expect(cardSignatures).toBe(before.signatures + 1);
		expect(cardIntents()).toHaveLength(before.intents + 1);
		expect(cardEntries()).toHaveLength(before.entries + 1);
	});

	it('offline, a rename completes on this device with its one card write queued instead of waiting for the server', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const before = counts();
		networkDown = () => true;

		await expect(em.updateOwnUserCardName('Renamed offline')).resolves.toMatchObject({ name: 'Renamed offline' });

		expect(counts()).toMatchObject({ intents: before.intents + 1, entries: before.entries + 1, signatures: before.signatures + 1 });
		expect((await outbox.pendingEntries(userHash)).filter((e) => e.relation === 'user_cards')).toHaveLength(1);
		expect(updatesSent()).toEqual([]);
	});

	it('pushCurrentUserCard: accepted is synced, one intent, one snapshot, one request', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const before = counts();

		await expect(em.pushCurrentUserCard()).resolves.toBe('synced');
		await cardWritesSettled(userHash);

		expect(counts()).toEqual({ intents: before.intents + 1, entries: before.entries + 1, signatures: before.signatures + 1, requests: before.requests + 1 });
		expect(updatesSent()).toHaveLength(1);
	});

	it('pushCurrentUserCard: a card write that cannot be delivered now is queued, stored once', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const before = counts();
		networkDown = () => true;

		await expect(em.pushCurrentUserCard()).resolves.toBe('queued');

		expect(counts()).toMatchObject({ intents: before.intents + 1, entries: before.entries + 1, signatures: before.signatures + 1 });
		expect((await outbox.pendingEntries(userHash)).filter((e) => e.relation === 'user_cards')).toHaveLength(1);
	});

	it('pushCurrentUserCard: a rejection is an error, never reported as queued', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		rejects = (m) => m[0].syncMetadata.relation === 'user_cards' && m[0].type === 'update';

		await expect(em.pushCurrentUserCard()).rejects.toMatchObject({ permanent: true });
		expect(updatesSent()).toEqual([]);
	});

	it('two card writes started together go out in the order of their timestamps: the next is authored only once the first is in the outbox', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		const intentsBefore = new Set(intentStore.map.keys());
		let widened = false;
		const realIntentGet = intentStore.get.bind(intentStore);
		intentStore.get = async (k) => {
			if (!widened && !intentsBefore.has(k) && intentStore.map.has(k)) {
				widened = true;
				const entries = cardEntries().length;
				for (let turn = 0; turn < 5000 && cardEntries().length === entries; turn++) await Promise.resolve();
			}
			return realIntentGet(k);
		};

		await expect(Promise.all([em.pushCurrentUserCard(), em.updateOwnUserCardName('Renamed')])).resolves.toEqual(['synced', expect.anything()]);

		const timestamps = updatesSent().map((m) => Number(rowOf(m).owner_timestamp));
		expect(timestamps).toHaveLength(2);
		expect(timestamps[1]).toBeGreaterThan(timestamps[0]);
	});

	it('a sign-in after the bootstrap card was accepted publishes no card again', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		await em.logout();
		const before = counts();

		await em.login(userHash);
		await cardWritesSettled(userHash);

		expect(counts()).toEqual(before);
	});
});

describe('no HTTP without durability', () => {
	it('an intent that cannot be stored: DurabilityError, no signature, no HTTP, nothing recorded as accepted', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const acceptedBefore = await getAccepted('user_cards', userHash);
		const httpBefore = httpSent.length;
		intentStore.failSet = () => true;

		await expect(em.updateOwnUserCardName('Renamed')).rejects.toBeInstanceOf(ingest.DurabilityError);

		expect(httpSent).toHaveLength(httpBefore);
		expect(cardSignatures).toBe(1);
		expect(await getAccepted('user_cards', userHash)).toEqual(acceptedBefore);
	});

	it('a signed snapshot the outbox cannot store: DurabilityError, no HTTP — and the signed intent is replayed exactly by recovery', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const httpBefore = httpSent.length;
		outboxStore.failSet = (k, v) => !k.includes('|') && v.includes('user_cards');

		await expect(em.updateOwnUserCardName('Renamed')).rejects.toBeInstanceOf(ingest.DurabilityError);
		expect(httpSent).toHaveLength(httpBefore);
		const held = cardIntents().find((i) => i.intent.signedMutation);
		expect(held).toBeTruthy();

		outboxStore.failSet = null;
		await intentRecovery.recoverIntents(userHash, await signKeyOf(em));
		await vi.waitFor(() => expect(httpSent).toHaveLength(httpBefore + 1));

		expect(httpSent.at(-1)![0]).toEqual(held.intent.signedMutation);
		expect(cardSignatures).toBe(2); // registration + the one update, never re-signed
	});
});

describe('crash and reload', () => {
	it('after the snapshot is stored but before HTTP completes, a reload replays the exact snapshot: one signature, one snapshot', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		hangs = (m) => m[0].type === 'update';

		void em.updateOwnUserCardName('Renamed').catch(() => {});
		await vi.waitFor(() => {
			expect(events.filter((e) => e === 'http:user_cards')).toHaveLength(2);
			expect(cardEntries().some((e) => e.mutations[0]?.type === 'update')).toBe(true);
		});
		const stored = cardEntries().find((e) => e.mutations[0]?.type === 'update');
		expect(httpSent.flat().filter((m) => m.type === 'update')).toEqual([]);

		hangs = () => false;
		const app = await reloadApp();
		await app.manager.login(userHash);
		await vi.waitFor(() => expect(httpSent.flat().filter((m) => m.type === 'update')).toHaveLength(1));

		expect(httpSent.flat().filter((m) => m.type === 'update')).toEqual([stored.mutations[0]]);
		expect(cardSignatures).toBe(2);
		expect(cardEntries()).toHaveLength(2);
		app.outbox.stopDrainLoop();
		await app.outbox._drainLoopSettledForTests();
		app.outbox._setLeaderForTests(null);
	});

	it('after HTTP acceptance but before the intent was resolved, recovery sends nothing again and stores no second snapshot', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		const userHash = (await em.getLocalUserCards())[0].user_hash;
		await em.updateOwnUserCardName('Renamed');
		const update = cardEntries().find((e) => e.status === 'accepted' && e.id !== cardEntries()[0].id) ?? cardEntries()[1];
		const intent = cardIntents().find((i) => i.intent.ref === update.id);
		const signedMutation = httpSent.flat().find((m) => m.type === 'update');
		intentStore.map.set(intent.id, JSON.stringify({ ...intent, intent: { kind: 'ready-row', relation: 'user_cards', mutationType: 'update', row: rowOf(signedMutation!), signedMutation } }));
		const httpBefore = httpSent.length;

		await intentRecovery.recoverIntents(userHash, await signKeyOf(em));

		expect(httpSent).toHaveLength(httpBefore);
		expect(cardEntries()).toHaveLength(2);
		expect(JSON.parse(intentStore.map.get(intent.id)!).intent).toMatchObject({ resolved: true, ref: update.id });
		expect(cardSignatures).toBe(2);
	});

	it('two sequential updates are separate intents and snapshots with strictly increasing timestamps — across a reload with the first still unsent', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';
		const first = em.updateOwnUserCardName('First');
		await vi.waitFor(() => expect(cardEntries().filter((e) => e.mutations[0]?.type === 'update')).toHaveLength(1));
		void first.catch(() => {});

		const app = await reloadApp();
		await app.manager.login(userHash);
		const second = app.manager.updateOwnUserCardName('Second');
		await vi.waitFor(() => expect(cardEntries().filter((e) => e.mutations[0]?.type === 'update')).toHaveLength(2));
		void second.catch(() => {});

		const updates = cardEntries().filter((e) => e.mutations[0]?.type === 'update');
		const [a, b] = updates.map((e) => rowOf(e.mutations[0]).owner_timestamp as number);
		expect(new Set(updates.map((e) => e.id)).size).toBe(2);
		expect(new Set(updates.map((e) => e.sourceIntentId)).size).toBe(2);
		expect(b).toBeGreaterThan(a);
		expect(updates[1].dependsOn).toContain(updates[0].id);
		app.outbox.stopDrainLoop();
		await app.outbox._drainLoopSettledForTests();
		app.outbox._setLeaderForTests(null);
	});
});

describe('bootstrap without a key, account isolation, concurrent recovery', () => {
	it('an unsigned card intent with no key available stays durable and is not a network retry; recovery signs it once', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const card = (await em.getLocalUserCards())[0] as unknown as Parameters<typeof publishUserCard>[0];
		const httpBefore = httpSent.length;

		await expect(publishUserCard(card, undefined as unknown as Uint8Array)).rejects.toThrow();

		const unsigned = cardIntents().find((i) => !i.intent.resolved && !i.intent.signedMutation);
		expect(unsigned).toBeTruthy();
		expect(cardEntries()).toHaveLength(1);
		expect(httpSent).toHaveLength(httpBefore);

		await intentRecovery.recoverIntents(userHash, await signKeyOf(em));
		await vi.waitFor(() => expect(httpSent).toHaveLength(httpBefore + 1));
		expect(cardSignatures).toBe(2);
		expect(rowOf(httpSent.at(-1)![0]).owner_timestamp).toBe(unsigned.intent.row.owner_timestamp);
	});

	it('an account switch never replays the other account\'s card snapshot', async () => {
		const emA = freshManager();
		const { user_hash: hashA } = await emA.createUserVault({ name: 'Alice' });
		networkDown = (m) => rowOf(m[0]).user_hash === hashA;
		const renaming = emA.updateOwnUserCardName('Alice 2');
		await vi.waitFor(() => expect(cardEntries().some((e) => e.mutations[0]?.type === 'update')).toBe(true));
		void renaming.catch(() => {});

		const emB = freshManager();
		await emB.createUserVault({ name: 'Bob' });
		outbox.stopDrainLoop();
		await outbox._drainLoopSettledForTests();

		const sentForA = httpSent.flat().filter((m) => rowOf(m).user_hash === hashA && m.type === 'update');
		expect(sentForA).toEqual([]);
		expect(cardEntries().find((e) => e.userHash === hashA && e.mutations[0]?.type === 'update')).toBeTruthy(); // kept for Alice
	});

	it('two tabs recovering the same card intent produce one signature, one snapshot and one HTTP send', { timeout: 20_000 }, async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		const card = (await em.getLocalUserCards())[0] as unknown as Parameters<typeof publishUserCard>[0];
		await publishUserCard(card, undefined as unknown as Uint8Array).catch(() => {});
		const signKey = await signKeyOf(em);
		const httpBefore = httpSent.length;
		const signaturesBefore = cardSignatures;

		const tails = new Map<string, Promise<void>>();
		vi.stubGlobal('navigator', {
			locks: {
				request<T>(name: string, optionsOrFn: unknown, maybeFn?: () => Promise<T>) {
					const fn = (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as (lock: unknown) => Promise<T>;
					const options = (typeof optionsOrFn === 'function' ? {} : optionsOrFn) as { ifAvailable?: boolean };
					if (options.ifAvailable && tails.has(name)) return Promise.resolve(fn(null));
					const run = (tails.get(name) ?? Promise.resolve()).then(() => fn({ name }));
					const tail = run.then(() => {}, () => {});
					tails.set(name, tail);
					void tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
					return run;
				},
			},
		});
		try {
			const tabs = [];
			for (let i = 0; i < 2; i++) {
				vi.resetModules();
				const tab = {
					intents: await import('@/lib/data/intents'),
					outbox: await import('@/lib/data/outbox'),
					recovery: await import('@/lib/data/intentRecovery'),
				};
				tab.intents._setIntentStorageForTests(intentStore);
				tab.outbox._setStorageForTests(outboxStore);
				tab.outbox._setLeaderForTests(true);
				tab.outbox._setActiveSessionForTests(userHash);
				tabs.push(tab);
			}
			await Promise.all(tabs.map((t) => t.recovery.recoverIntents(userHash, signKey)));
			await vi.waitFor(() => expect(httpSent.length).toBeGreaterThanOrEqual(httpBefore + 1));
			for (const t of tabs) {
				t.outbox.stopDrainLoop();
				await t.outbox._drainLoopSettledForTests();
				t.outbox._setLeaderForTests(null);
			}
		} finally {
			vi.unstubAllGlobals();
		}

		expect(cardSignatures - signaturesBefore).toBe(1);
		expect(cardEntries().filter((e) => e.mutations[0]?.type === 'update' || e.relation === 'user_cards' && e.status === 'accepted' && e.id !== cardEntries()[0].id)).toHaveLength(1);
		expect(httpSent.length - httpBefore).toBe(1);
	});
});

const watchAuth = (em: Manager) => {
	em.addEventListener('authChange', (e) => {
		events.push(`authChange:${(e as CustomEvent<{ isAuthenticated: boolean }>).detail.isAuthenticated}`);
	});
	return em;
};

describe('card timestamps are reserved one at a time per account, in every tab', () => {
	const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

	it('two tabs authoring card updates at once get different, strictly increasing timestamps (Web Lock)', { timeout: 20_000 }, async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		const card = (await em.getLocalUserCards())[0] as unknown as Parameters<typeof storeUserCardIntent>[0];
		vi.spyOn(Date, 'now').mockReturnValue(NOW);

		const tails = new Map<string, Promise<void>>();
		vi.stubGlobal('navigator', {
			locks: {
				request<T>(name: string, fn: () => Promise<T>) {
					const run = (tails.get(name) ?? Promise.resolve()).then(fn);
					const tail = run.then(() => {}, () => {});
					tails.set(name, tail);
					return run;
				},
			},
		});
		try {
			const tabs = [];
			for (let i = 0; i < 2; i++) {
				vi.resetModules();
				const tab = {
					intents: await import('@/lib/data/intents'),
					outbox: await import('@/lib/data/outbox'),
					cards: await import('@/lib/data/userCardIntent'),
				};
				tab.intents._setIntentStorageForTests(intentStore);
				tab.outbox._setStorageForTests(outboxStore);
				(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStore('accepted', []));
				tabs.push(tab);
			}
			const [a, b] = await Promise.all(tabs.map((t, i) => t.cards.storeUserCardIntent({ ...card, name: `Tab ${i}` })));
			const [ta, tb] = [a.readyRow.row.owner_timestamp as number, b.readyRow.row.owner_timestamp as number];
			expect(ta).not.toBe(tb);
			expect(Math.max(ta, tb)).toBeGreaterThan(Math.min(ta, tb));
			const stored = cardIntents().filter((i) => i.intent.mutationType === 'update').map((i) => i.intent.row.owner_timestamp);
			expect(new Set(stored).size).toBe(2);
		} finally {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		}
	});

	it('concurrent card updates in one tab without Web Locks get different, strictly increasing timestamps (in-context queue)', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		const card = (await em.getLocalUserCards())[0] as unknown as Parameters<typeof storeUserCardIntent>[0];
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		try {
			const results = await Promise.all([0, 1, 2].map((i) => storeUserCardIntent({ ...card, name: `Edit ${i}` })));
			const timestamps = results.map((r) => r.readyRow.row.owner_timestamp as number);
			expect(new Set(timestamps).size).toBe(3);
			expect([...timestamps].sort((x, y) => x - y)).toEqual(timestamps);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('a timestamp reserved for an intent that could not be stored is never handed out again (a gap, not a reuse)', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		try {
			intentStore.failSet = () => true;
			await expect(em.updateOwnUserCardName('Lost')).rejects.toBeInstanceOf(ingest.DurabilityError);
			const reserved = JSON.parse(outboxStore.map.get(`clock|user_cards|${userHash}`)!).highWater as number;

			intentStore.failSet = null;
			await em.updateOwnUserCardName('Kept');

			expect(rowOf(httpSent.at(-1)![0]).owner_timestamp).toBeGreaterThan(reserved);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('a reservation that cannot be stored stops the write: no intent, no signature, no HTTP', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		const intentsBefore = cardIntents().length;
		const httpBefore = httpSent.length;
		outboxStore.failSet = (k) => k.startsWith('clock|');

		await expect(em.updateOwnUserCardName('Renamed')).rejects.toThrow();

		expect(cardIntents()).toHaveLength(intentsBefore);
		expect(cardSignatures).toBe(1);
		expect(httpSent).toHaveLength(httpBefore);
	});
});

describe('an unreadable card write of this account blocks new card authoring; others\' records do not', () => {
	const blocked = async (setup: (ids: { intentKeys: string[]; entryKeys: string[] }) => void) => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		setup({
			intentKeys: [...intentStore.map.keys()].filter((k) => !k.startsWith('owner|')),
			entryKeys: [...outboxStore.map.keys()].filter((k) => !k.includes('|')),
		});
		const intentsBefore = intentStore.map.size;
		const httpBefore = httpSent.length;
		const attempt = em.updateOwnUserCardName('Renamed');
		return { attempt, intentsBefore, httpBefore };
	};

	it.each([
		['an own intent that cannot be read', ({ intentKeys }: { intentKeys: string[] }) => {
			const realGet = intentStore.get.bind(intentStore);
			intentStore.get = async (k: string) => { if (k === intentKeys[0]) throw new Error('disk read error'); return realGet(k); };
		}],
		['an own intent that cannot be parsed', ({ intentKeys }: { intentKeys: string[] }) => { intentStore.map.set(intentKeys[0], 'not json'); }],
		['an own outbox record that cannot be read', ({ entryKeys }: { entryKeys: string[] }) => {
			const realGet = outboxStore.get.bind(outboxStore);
			outboxStore.get = async (k: string) => { if (k === entryKeys[0]) throw new Error('disk read error'); return realGet(k); };
		}],
		['an own corrupt outbox record', ({ entryKeys }: { entryKeys: string[] }) => { outboxStore.map.set(entryKeys[0], 'not json'); }],
	])('%s: no new intent, no signature, no HTTP', async (_name, setup) => {
		const { attempt, intentsBefore, httpBefore } = await blocked(setup as never);

		await expect(attempt).rejects.toBeInstanceOf(CardAuthoringBlockedError);

		expect(intentStore.map.size).toBe(intentsBefore);
		expect(cardSignatures).toBe(1);
		expect(httpSent).toHaveLength(httpBefore);
	});

	it('another account\'s sealed intent, its outbox entries, and device-level records do not block', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		intentStore.map.set('intent-foreign', 'opaque');
		const realGet = intentStore.get.bind(intentStore);
		intentStore.get = async (k: string) => { if (k === 'intent-foreign') throw new DecryptFailedError('another account'); return realGet(k); };
		intentStore.map.set('owner|intent-other', JSON.stringify({ userHash: 'u_' + 'b'.repeat(128) }));
		intentStore.map.set('intent-other', 'unreadable');
		intentStore.map.set('intent-orphan', 'unreadable');
		const scanGet = intentStore.get.bind(intentStore);
		intentStore.get = async (k: string) => { if (k === 'intent-other' || k === 'intent-orphan') throw new Error('disk read error'); return scanGet(k); };
		outboxStore.map.set('000000001-0000-dev0', 'not json');
		outboxStore.map.set('000000001-0000-oth0', JSON.stringify({
			id: '000000001-0000-oth0', userHash: 'u_' + 'b'.repeat(128), relation: 'user_cards', createdAt: 1, attempts: 0, lastError: null,
			mutations: [{ type: 'update', original: {}, changes: { owner_timestamp: 9_999_999_999 }, syncMetadata: { relation: 'user_cards' } }],
		}));

		await em.updateOwnUserCardName('Renamed');

		expect(rowOf(httpSent.at(-1)![0]).name).toBe('Renamed');
		expect(rowOf(httpSent.at(-1)![0]).owner_timestamp).toBeLessThan(9_999_999_999); // another account's timestamp is not this card's base
	});
});

describe('import reports whether the card write is durable', () => {
	const exported = async () => {
		const source = freshManager();
		await source.createUserVault({ name: 'Imported' });
		const keys = await source.exportVaultKeys();
		const identity = { ...(await source.getLocalUserCards())[0] };
		await source.logout();
		await newDevice();
		return { keys, identity };
	};

	it('an intent store failure fails the import honestly: no HTTP, no card intent, no session, no promise of later recovery — and a retry reuses the restored account', async () => {
		const { keys, identity } = await exported();
		const intentsBefore = cardIntents().length;
		const httpBefore = httpSent.length;
		intentStore.failSet = () => true;
		const warn = vi.spyOn(console, 'warn');
		events.length = 0;

		const target = watchAuth(freshManager());
		const failure = await target.importVaultKeys(keys, identity).then(() => null, (e) => e);

		expect(failure).toBeInstanceOf(AccountImportIncompleteError);
		expect(httpSent).toHaveLength(httpBefore);
		expect(cardIntents()).toHaveLength(intentsBefore);
		expect(target.isAuth).toBe(false);
		expect(target.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(warn.mock.calls.flat().join(' ')).not.toMatch(/deferred|next sign-in|next login/);
		warn.mockRestore();
		const vaultsAfterFailure = vaults.size;

		intentStore.failSet = null;
		const retry = await target.importVaultKeys(keys, identity);
		expect(retry).toEqual({ status: 'active', userHash: identity.user_hash });
		expect(vaults.size).toBe(vaultsAfterFailure);
		expect((await target.getLocalUserCards()).filter((c) => c.user_hash === identity.user_hash)).toHaveLength(1);
	});

	it('a stored card write that cannot be delivered now: import restores locally with delivery deferred, and the next sign-in replays that exact write', async () => {
		const { keys, identity } = await exported();
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';
		const target = watchAuth(freshManager());
		events.length = 0;

		vi.useFakeTimers({ toFake: ['setTimeout'] });
		let result: { status: string } | undefined;
		try {
			const importing = target.importVaultKeys(keys, identity).then((r) => { result = r; });
			while (result === undefined) await vi.advanceTimersByTimeAsync(5_000);
			await importing;
		} finally {
			vi.useRealTimers();
		}

		expect(result).toEqual({ status: 'card-deferred', userHash: identity.user_hash });
		expect(target.isAuth).toBe(false);
		expect(events).not.toContain('authChange:true');
		const stored = cardEntries().find((e) => e.userHash === identity.user_hash && e.mutations[0]?.type === 'insert' && e.status !== 'accepted');
		expect(stored).toBeTruthy();

		networkDown = () => false;
		await whenRetryIsDue(() => target.login(identity.user_hash));
		await vi.waitFor(() => expect(httpSent.flat().filter((m) => JSON.stringify(m) === JSON.stringify(stored.mutations[0]))).toHaveLength(1));
	});
});

describe('no active session before the card boundary', () => {
	it('registration: no authChange, recovery or HTTP before the card intent; the session activates exactly once, after acceptance, before user_storage', async () => {
		const em = watchAuth(freshManager());
		await em.createUserVault({ name: 'Tester' });
		await vi.waitFor(() => expect(events).toContain('recoverIntents'));

		const [intent] = cardIntents();
		const [entry] = cardEntries();
		const intentAt = at(`intent:${intent.id}`);
		expect(at('authChange:true')).toBeGreaterThan(intentAt);
		expect(at('recoverIntents')).toBeGreaterThan(intentAt);
		expect(at('http:')).toBeGreaterThan(intentAt);
		expect(at(`outbox:${entry.id}`)).toBeLessThan(at('recoverIntents'));
		expect(at('http:user_cards')).toBeLessThan(at('authChange:true'));
		expect(at('authChange:true')).toBeLessThan(at('user_storage'));
		expect(events.filter((e) => e === 'authChange:true')).toHaveLength(1);
	});

	it.each([
		['the server rejects the card', () => { rejects = (m) => m[0].syncMetadata.relation === 'user_cards'; }],
		['the card intent cannot be stored', () => { intentStore.failSet = () => true; }],
	])('%s: registration fails and leaves no authenticated session', async (_name, setup) => {
		setup();
		const em = watchAuth(freshManager());

		await expect(em.createUserVault({ name: 'Tester' })).rejects.toThrow();

		expect(em.isAuth).toBe(false);
		expect(em.currentUserHash).toBeNull();
		expect(em.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(events).not.toContain('recoverIntents');
		expect(events).not.toContain('user_storage');
	});
});

const newDevice = async () => {
	intentStore = makeStore('intent', events);
	outboxStore = makeStore('outbox', events);
	acceptedStore = makeStore('accepted', []);
	intents._setIntentStorageForTests(intentStore);
	outbox._setStorageForTests(outboxStore);
	_setAcceptedSnapshotStorageForTests(acceptedStore);
	await rawStore.remove('pq-vaults-registry');
};

const exportAccount = async () => {
	const source = freshManager();
	await source.createUserVault({ name: 'Imported' });
	const keys = await source.exportVaultKeys();
	const identity = { ...(await source.getLocalUserCards())[0] };
	await source.logout();
	return { keys, identity };
};

const whenRetryIsDue = async <T>(fn: () => Promise<T>): Promise<T> => {
	const later = Date.now() + 10 * 60_000;
	const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
	try {
		return await fn();
	} finally {
		clock.mockRestore();
	}
};

const importFast = async (em: Manager, keys: unknown, identity: Row) => {
	vi.useFakeTimers({ toFake: ['setTimeout'] });
	let settled: { value?: { status: string; userHash: string }; error?: unknown } | undefined;
	try {
		const importing = em.importVaultKeys(keys, identity).then((value) => { settled = { value }; }, (error) => { settled = { error }; });
		while (settled === undefined) await vi.advanceTimersByTimeAsync(5_000);
		await importing;
	} finally {
		vi.useRealTimers();
	}
	if (settled!.error) throw settled!.error;
	return settled!.value!;
};

describe('an account whose card is still unaccepted signs in only through the card boundary', () => {
	const deferredImport = async () => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';
		const target = watchAuth(freshManager());
		const result = await importFast(target, keys, identity);
		expect(result).toEqual({ status: 'card-deferred', userHash: identity.user_hash });
		networkDown = () => false;
		events.length = 0;
		return { target, userHash: identity.user_hash as string };
	};

	it('card-deferred → login: the same stored card goes out first; the session activates once, after acceptance, before any recovery', async () => {
		const { target, userHash } = await deferredImport();
		const [intent] = cardIntents();
		const stored = cardEntries().find((e) => e.status !== 'accepted')!;
		expect(stored.sourceIntentId).toBe(intent.id);
		const signaturesBefore = cardSignatures;

		await whenRetryIsDue(() => target.login(userHash));
		await vi.waitFor(() => expect(events).toContain('recoverIntents'));

		const sent = httpSent.flat().filter((m) => m.syncMetadata.relation === 'user_cards');
		expect(sent.at(-1)).toEqual(stored.mutations[0]);
		expect(cardSignatures).toBe(signaturesBefore);
		expect(cardIntents().map((i) => i.id)).toEqual([intent.id]);
		expect(cardEntries().map((e) => e.id)).toEqual([stored.id]);
		expect(cardEntries()[0].status).toBe('accepted');
		expect(at('http:user_cards')).toBeLessThan(at('authChange:true'));
		expect(at('authChange:true')).toBeLessThan(at('recoverIntents'));
		expect(events.filter((e) => e === 'authChange:true')).toHaveLength(1);
		expect(events).not.toContain('user_storage');
		expect(target.isAuth).toBe(true);
	});

	it('card-deferred → login with the card rejected: no session, no recovery', async () => {
		const { target, userHash } = await deferredImport();
		rejects = (m) => m[0].syncMetadata.relation === 'user_cards';

		await expect(whenRetryIsDue(() => target.login(userHash))).rejects.toBeInstanceOf(BootstrapCardRejectedError);

		expect(target.isAuth).toBe(false);
		expect(target.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(events).not.toContain('recoverIntents');
	});

	it('card-deferred → login still offline: an explicit deferred login, no session', async () => {
		const { target, userHash } = await deferredImport();
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';

		await expect(target.login(userHash)).rejects.toBeInstanceOf(LoginDeferredError);

		expect(target.isAuth).toBe(false);
		expect(events).not.toContain('authChange:true');
		expect(events).not.toContain('recoverIntents');
		expect(cardEntries().find((e) => e.status !== 'accepted')!.attempts).toBeGreaterThanOrEqual(1);
	});

	it('an unsigned bootstrap card is signed once at login with its stored timestamp, then the session activates', async () => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		signingFails = true;
		const target = watchAuth(freshManager());
		const result = await target.importVaultKeys(keys, identity);
		expect(result.status).toBe('card-deferred');
		const [unsigned] = cardIntents();
		expect(unsigned.intent.signedMutation).toBeUndefined();
		signingFails = false;
		events.length = 0;
		const signaturesBefore = cardSignatures;

		await target.login(identity.user_hash as string);

		expect(cardSignatures).toBe(signaturesBefore + 1);
		expect(rowOf(httpSent.at(-1)![0]).owner_timestamp).toBe(unsigned.intent.row.owner_timestamp);
		expect(at('http:user_cards')).toBeLessThan(at('authChange:true'));
		expect(target.isAuth).toBe(true);
	});

	it('an account whose card is known accepted signs in even while the intent store cannot be listed', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		await em.logout();
		intentStore.keys = async () => { throw new Error('disk read error'); };

		const again = watchAuth(freshManager());
		await again.login(userHash);

		expect(again.isAuth).toBe(true);
	});

	it('an ordinary card update still pending does not hold up a sign-in', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		networkDown = (m) => m[0].type === 'update';
		void em.updateOwnUserCardName('Renamed').catch(() => {});
		await vi.waitFor(() => expect(cardEntries().some((e) => e.mutations[0]?.type === 'update')).toBe(true));
		await em.logout();
		const bootstrap = cardIntents().find((i) => i.intent.purpose === 'bootstrap-prerequisite');
		intentStore.map.delete(bootstrap.id);
		acceptedStore.map.clear();
		cardRows.set(userHash, acceptedCardOf(userHash));
		events.length = 0;

		const again = watchAuth(freshManager());
		await again.login(userHash);

		expect(again.isAuth).toBe(true);
		expect(events).toContain('authChange:true');
	});
});

describe('import: before the durable milestone every failure is an incomplete import', () => {
	type FailurePoint = [name: string, arrange: () => void, disarm: () => void];
	let restoreLocks: (() => void) | null = null;
	const points: FailurePoint[] = [
		['reading the card clock', () => {
			const get = outboxStore.get.bind(outboxStore);
			outboxStore.get = async (k: string) => { if (k.startsWith('clock|')) throw new Error('disk read error'); return get(k); };
		}, () => { outboxStore.get = async (k: string) => outboxStore.map.get(k) ?? null; }],
		['storing the timestamp reservation', () => { outboxStore.failSet = (k) => k.startsWith('clock|'); }, () => { outboxStore.failSet = null; }],
		['reading the accepted card', () => { acceptedStore.get = async () => { throw new Error('disk read error'); }; }, () => { acceptedStore.get = async (k: string) => acceptedStore.map.get(k) ?? null; }],
		['taking the account lock', () => {
			vi.stubGlobal('navigator', { locks: { request: async () => { throw new Error('lock manager unavailable'); } } });
			restoreLocks = () => vi.unstubAllGlobals();
		}, () => { restoreLocks?.(); restoreLocks = null; }],
		['scanning this account\'s intents', () => { intentStore.keys = async () => { throw new Error('disk read error'); }; }, () => { intentStore.keys = async () => [...intentStore.map.keys()]; }],
		['scanning this account\'s outbox', () => {
			const keys = outboxStore.keys.bind(outboxStore);
			let listed = 0;
			outboxStore.keys = async () => { listed++; if (listed === 1) throw new Error('disk read error'); return keys(); };
		}, () => { outboxStore.keys = async () => [...outboxStore.map.keys()]; }],
		['storing the intent', () => { intentStore.failSet = (k) => !k.startsWith('owner|'); }, () => { intentStore.failSet = null; }],
	];

	it.each(points)('%s fails: AccountImportIncompleteError, no session, no HTTP — and a retry reuses the vault and identity', async (_name, arrange, disarm) => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		const httpBefore = httpSent.length;
		const target = watchAuth(freshManager());
		events.length = 0;
		arrange();

		const failure = await target.importVaultKeys(keys, identity).then(() => null, (e) => e);
		disarm();

		expect(failure).toBeInstanceOf(AccountImportIncompleteError);
		expect(target.isAuth).toBe(false);
		expect(target.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(httpSent).toHaveLength(httpBefore);
		const vaultsAfterFailure = vaults.size;

		const retry = await target.importVaultKeys(keys, identity);
		expect(retry.status).toBe('active');
		expect(vaults.size).toBe(vaultsAfterFailure);
		expect((await target.getLocalUserCards()).filter((c) => c.user_hash === identity.user_hash)).toHaveLength(1);
	});
});

describe('a bootstrap retry reuses the one stored bootstrap operation', () => {
	const bootstrapIntents = () => cardIntents().filter((i) => i.intent.purpose === 'bootstrap-prerequisite');
	const ownerRecords = () => [...intentStore.map.keys()].filter((k) => k.startsWith('owner|'));
	const clockOf = (userHash: string) => outboxStore.map.get(`clock|user_cards|${userHash}`);
	const cardInsertsSent = () => httpSent.flat().filter((m) => m.syncMetadata.relation === 'user_cards' && m.type === 'insert');

	const deferred = async () => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';
		const first = await importFast(freshManager(), keys, identity);
		expect(first.status).toBe('card-deferred');
		networkDown = () => false;
		const [intent] = bootstrapIntents();
		const stored = cardEntries().find((e) => e.status !== 'accepted')!;
		return {
			keys, identity, userHash: identity.user_hash as string, intent, stored,
			before: { signatures: cardSignatures, owners: ownerRecords().length, clock: clockOf(identity.user_hash as string), sent: cardInsertsSent().length },
		};
	};

	const expectSameOperation = (d: Awaited<ReturnType<typeof deferred>>) => {
		expect(bootstrapIntents().map((i) => i.id)).toEqual([d.intent.id]);
		expect(cardEntries().map((e) => e.id)).toEqual([d.stored.id]);
		expect(cardSignatures).toBe(d.before.signatures);
		expect(ownerRecords()).toHaveLength(d.before.owners);
		expect(clockOf(d.userHash)).toBe(d.before.clock);
		const sentNow = cardInsertsSent().slice(d.before.sent);
		expect(sentNow).toEqual([d.stored.mutations[0]]);
		expect(rowOf(sentNow[0]).owner_timestamp).toBe(rowOf(d.stored.mutations[0]).owner_timestamp);
	};

	it('card-deferred → import again once the network is back: the same intent, timestamp, signature, snapshot and outbox entry, sent once', async () => {
		const d = await deferred();

		const retry = await whenRetryIsDue(() => freshManager().importVaultKeys(d.keys, d.identity));

		expect(retry).toEqual({ status: 'active', userHash: d.userHash });
		expectSameOperation(d);
	});

	it('the same after a reload between the two imports', async () => {
		const d = await deferred();

		const app = await reloadApp({ afterSession: false });
		try {
			const retry = await whenRetryIsDue(() => app.manager.importVaultKeys(d.keys, d.identity));
			expect(retry.status).toBe('active');
			expectSameOperation(d);
		} finally {
			app.outbox.stopDrainLoop();
			await app.outbox._drainLoopSettledForTests();
			app.outbox._setLeaderForTests(null);
		}
	});

	it('two tabs retrying the import at once share the one operation: no duplicate intent, signature, snapshot or dispatch', { timeout: 45_000 }, async () => {
		const d = await deferred();
		const tails = new Map<string, Promise<void>>();
		vi.stubGlobal('navigator', {
			locks: {
				request<T>(name: string, optionsOrFn: unknown, maybeFn?: (lock: unknown) => Promise<T>) {
					const fn = (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as (lock: unknown) => Promise<T>;
					const options = (typeof optionsOrFn === 'function' ? {} : optionsOrFn) as { ifAvailable?: boolean };
					if (options.ifAvailable && tails.has(name)) return Promise.resolve(fn(null));
					const run = (tails.get(name) ?? Promise.resolve()).then(() => fn({ name }));
					const tail = run.then(() => {}, () => {});
					tails.set(name, tail);
					void tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
					return run;
				},
			},
		});
		const tabs: Array<Awaited<ReturnType<typeof reloadApp>>> = [];
		try {
			for (let i = 0; i < 2; i++) tabs.push(await reloadApp({ afterSession: false }));
			const results = await whenRetryIsDue(() => Promise.all(tabs.map((t) => t.manager.importVaultKeys(d.keys, { ...d.identity }))));

			expect(results.map((r) => r.status)).toEqual(['active', 'active']);
			expectSameOperation(d);
		} finally {
			for (const t of tabs) {
				t.outbox.stopDrainLoop();
				await t.outbox._drainLoopSettledForTests();
				t.outbox._setLeaderForTests(null);
			}
			vi.unstubAllGlobals();
		}
	});

	it('re-importing where the card is known accepted publishes nothing new and signs in', async () => {
		const { keys, identity } = await exportAccount();
		const httpBefore = httpSent.length;
		const intentsBefore = cardIntents().length;

		const result = await freshManager().importVaultKeys(keys, identity);

		expect(result.status).toBe('active');
		expect(httpSent).toHaveLength(httpBefore);
		expect(cardIntents()).toHaveLength(intentsBefore);
	});
});

describe('sign-in needs positive proof of the card, or the exact bootstrap replay', () => {
	const signedOut = async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		await em.logout();
		return userHash;
	};
	const dropBootstrapIntent = () => {
		const bootstrap = cardIntents().find((i) => i.intent.purpose === 'bootstrap-prerequisite');
		intentStore.map.delete(bootstrap.id);
		intentStore.map.delete(`owner|${bootstrap.id}`);
	};
	const expectNoSession = async (userHash: string, error: unknown = CardAuthoringBlockedError) => {
		const httpBefore = httpSent.length;
		const em = watchAuth(freshManager());
		events.length = 0;

		await expect(em.login(userHash)).rejects.toBeInstanceOf(error as never);

		expect(em.isAuth).toBe(false);
		expect(em.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(events).not.toContain('recoverIntents');
		expect(httpSent).toHaveLength(httpBefore);
	};

	it('no shape card, an unreadable accepted card, no bootstrap intent: no session', async () => {
		const userHash = await signedOut();
		dropBootstrapIntent();
		acceptedStore.get = async () => { throw new Error('disk read error'); };

		await expectNoSession(userHash);
	});

	it('no shape card, a corrupt accepted card, no bootstrap intent: no session', async () => {
		const userHash = await signedOut();
		dropBootstrapIntent();
		for (const key of acceptedStore.map.keys()) acceptedStore.map.set(key, 'not json');

		await expectNoSession(userHash);
	});

	it('no shape card, an accepted card for another account, no bootstrap intent: no session', async () => {
		const userHash = await signedOut();
		dropBootstrapIntent();
		for (const [key, value] of acceptedStore.map) acceptedStore.map.set(key, JSON.stringify({ ...JSON.parse(value), user_hash: 'u_' + 'b'.repeat(128) }));

		await expectNoSession(userHash);
	});

	it('no shape card, no accepted card, and the bootstrap intent unreadable: no session — once it reads again, the exact stored operation goes out', async () => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		networkDown = (m) => m[0].syncMetadata.relation === 'user_cards';
		expect((await importFast(freshManager(), keys, identity)).status).toBe('card-deferred');
		networkDown = () => false;
		const userHash = identity.user_hash as string;
		const [bootstrap] = cardIntents();
		const stored = cardEntries().find((e) => e.status !== 'accepted')!;
		const intentsBefore = intentStore.map.size;
		const realGet = intentStore.get.bind(intentStore);
		intentStore.get = async (k: string) => { if (k === bootstrap.id) throw new Error('disk read error'); return realGet(k); };

		await expectNoSession(userHash);

		intentStore.get = realGet;
		const em = watchAuth(freshManager());
		events.length = 0;
		await whenRetryIsDue(() => em.login(userHash));

		expect(em.isAuth).toBe(true);
		expect(httpSent.flat().filter((m) => m.type === 'insert').at(-1)).toEqual(stored.mutations[0]);
		expect(intentStore.map.size).toBe(intentsBefore);
		expect(at('http:user_cards')).toBeLessThan(at('authChange:true'));
	});

	it('the card in the shape lets a sign-in through even while intents cannot be listed and no accepted card is stored', async () => {
		const userHash = await signedOut();
		acceptedStore.map.clear();
		cardRows.set(userHash, acceptedCardOf(userHash));
		intentStore.keys = async () => { throw new Error('disk read error'); };

		const em = freshManager();
		await em.login(userHash);

		expect(em.isAuth).toBe(true);
	});

	it('a locally accepted card lets a sign-in through only when it was read and is this account\'s', async () => {
		const userHash = await signedOut();
		dropBootstrapIntent();

		const em = freshManager();
		await em.login(userHash);

		expect(em.isAuth).toBe(true);
	});
});

describe('the card decision gates sign-in and import before anything irreversible', () => {
	const linkCards = async () => {
		const matchers = new Set<{ fn: (m: unknown) => boolean; resolve: (v: boolean) => void }>();
		const link = createShapeLink();
		const coll = {
			async preload() {},
			get: (k: string) => cardRows.get(k),
			get toArray() { return [...cardRows.values()]; },
			utils: { awaitMatch: (fn: (m: unknown) => boolean) => new Promise<boolean>((resolve) => matchers.add({ fn, resolve })) },
		};
		registerShapeLink(coll, link);
		linkedCards = coll;
		return {
			fail: () => link.report(),
			goLive: async () => {
				for (const m of [...matchers]) if (m.fn({ headers: { control: 'up-to-date' } })) { matchers.delete(m); m.resolve(true); }
				await whenLive(coll);
			},
		};
	};

	it('sign-in with no card proven anywhere: no session, authChange, recovery, drain or HTTP', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
		await em.logout();
		const bootstrap = cardIntents().find((i) => i.intent.purpose === 'bootstrap-prerequisite');
		intentStore.map.delete(bootstrap.id);
		intentStore.map.delete(`owner|${bootstrap.id}`);
		acceptedStore.map.clear();
		const httpBefore = httpSent.length;
		const again = watchAuth(freshManager());
		events.length = 0;

		const failure = await again.login(userHash).then(() => null, (e) => e);

		expect(failure).toBeInstanceOf(CardAuthoringBlockedError);
		expect(failure.reason).toBe('card_unproven');
		expect(again.isAuth).toBe(false);
		expect(again.localStorageOwnerHash).toBeNull();
		expect(events).not.toContain('authChange:true');
		expect(events).not.toContain('recoverIntents');
		expect(httpSent).toHaveLength(httpBefore);
	});

	it('import where the shape is not live: nothing reserved, stored, signed or sent; once it is live, the retry publishes one bootstrap', async () => {
		const { keys, identity } = await exportAccount();
		await newDevice();
		const cards = await linkCards();
		cards.fail();
		const httpBefore = httpSent.length;
		const signaturesBefore = cardSignatures;
		const target = watchAuth(freshManager());
		events.length = 0;

		const failure = await target.importVaultKeys(keys, identity).then(() => null, (e) => e);

		expect(failure).toBeInstanceOf(AccountImportIncompleteError);
		expect(failure.cause).toMatchObject({ reason: 'shape_unavailable' });
		expect(cardIntents()).toHaveLength(0);
		expect(outboxStore.map.has(`clock|user_cards|${identity.user_hash}`)).toBe(false);
		expect(cardSignatures).toBe(signaturesBefore);
		expect(httpSent).toHaveLength(httpBefore);
		expect(target.isAuth).toBe(false);
		expect(events).not.toContain('authChange:true');

		await cards.goLive();
		const retry = await target.importVaultKeys(keys, identity);

		expect(retry).toEqual({ status: 'active', userHash: identity.user_hash });
		expect(cardIntents()).toHaveLength(1);
		expect(httpSent.flat().slice(httpBefore).filter((m) => m.syncMetadata.relation === 'user_cards').map((m) => m.type)).toEqual(['insert']);
	});
});
