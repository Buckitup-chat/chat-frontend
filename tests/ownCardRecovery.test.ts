import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setStorageForTests as setOutboxStorage, _setLeaderForTests, stopDrainLoop, pendingCardWrites } from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { withCardLock } from '@/lib/data/userCardIntent';
import { openSession, bearerFor, clearSessions } from '@/lib/data/readSession';

const makeMemoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const makeVault = (id: string) => {
	const data = new Map<string, unknown>();
	return {
		id,
		async set(k: string, v: unknown) { data.set(k, v); },
		async get(k: string) { return data.get(k); },
	};
};

let vaults: Map<string, ReturnType<typeof makeVault>>;
let rawStore: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> };

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

vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		async preload() {},
		get: () => undefined,
		get toArray() { return []; },
	}),
}));

vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => 'synced',
}));

type Sent = { type: string; modified?: { user_hash?: string }; syncMetadata: { relation: string } };

let serverCards: Set<string>;
let log: string[];
let ingestBatches: Sent[][];
let refuseCards: boolean;
let unavailableCards: boolean;
let holdReadSession: Promise<void> | null;

vi.mock('@/api/client', async () => {
	const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: async (mutations: Sent[]) => {
				ingestBatches.push(mutations);
				if (unavailableCards && mutations.some((m) => m.syncMetadata.relation === 'user_cards')) {
					log.push('ingest:503');
					return { status: 503, json: async () => ({}) } as unknown as Response;
				}
				log.push(`ingest:${mutations.map((m) => `${m.syncMetadata.relation}.${m.type}`).join(',')}`);
				const results = mutations.map((m, index) => {
					if (m.syncMetadata.relation !== 'user_cards') return { index, status: 'ok', txid: 100 + index };
					if (refuseCards) return { index, status: 'error', error: 'validation_failed' };
					if (m.type === 'insert') serverCards.add(m.modified!.user_hash!);
					return { index, status: 'ok', txid: 100 + index };
				});
				const status = results.some((r) => r.status === 'error') ? 422 : 200;
				return { status, json: async () => ({ results }) } as unknown as Response;
			},
		},
	};
});

let challengeSeq = 0;
let userA = '';
let userB = '';
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const installServer = () => {
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/challenge')) {
			const id = `cid-${++challengeSeq}`;
			log.push(`challenge:${id}`);
			return json(200, { challenge_id: id, challenge: 'ab'.repeat(32) });
		}
		if (url.endsWith('/read_session')) {
			const body = JSON.parse(String(init?.body));
			if (userA && userB) log.push(`read_session_request:${body.user_hash === userA ? 'A' : 'B'}`);
			if (holdReadSession) await holdReadSession;
			const known = serverCards.has(body.user_hash);
			log.push(`read_session:${body.shape}:${body.challenge_id}:${known ? 'ok' : 'unknown_user'}`);
			return known
				? json(200, { token: `tok-${body.shape}-${body.challenge_id}`, shape: body.shape, expires_in: 300 })
				: json(401, { error: 'unknown_user' });
		}
		throw new Error(`unexpected fetch ${url}`);
	});
};

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

interface TestManager {
	createUserVault(opts: { name: string }): Promise<{ user_hash: string }>;
	login(userHash: string): Promise<unknown>;
	logout(): Promise<void>;
	readonly currentUserHash: string | null;
}

const freshManager = (): TestManager => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance() as unknown as TestManager;
};

const cardBatches = () => ingestBatches.filter((batch) => batch.some((m) => m.syncMetadata.relation === 'user_cards'));
const readSessions = () => log.filter((line) => line.startsWith('read_session:'));
const challenges = () => log.filter((line) => line.startsWith('challenge:'));

beforeEach(() => {
	vaults = new Map();
	serverCards = new Set();
	log = [];
	ingestBatches = [];
	refuseCards = false;
	unavailableCards = false;
	holdReadSession = null;
	userA = '';
	userB = '';
	challengeSeq = 0;
	const store = new Map<string, unknown>();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	setOutboxStorage(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setIntentStorageForTests(makeMemoryStore());
	_setLeaderForTests(true);
	clearSessions();
	installServer();
});

afterEach(() => {
	clearSessions();
	_setLeaderForTests(null);
	stopDrainLoop();
	vi.unstubAllGlobals();
});

const signedInAfterWipe = async () => {
	const em = freshManager();
	const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });
	await em.login(userHash);
	await withCardLock(userHash, async () => {});
	serverCards.clear();
	log = [];
	ingestBatches = [];
	return { em, userHash };
};

describe('the own card goes first, alone', () => {
	it('registration sends the card as a single-mutation request before anything else', async () => {
		const em = freshManager();
		const { user_hash: userHash } = await em.createUserVault({ name: 'Tester' });

		expect(ingestBatches[0]).toHaveLength(1);
		expect(ingestBatches[0][0]).toMatchObject({ type: 'insert', syncMetadata: { relation: 'user_cards' } });
		expect(cardBatches().every((batch) => batch.length === 1)).toBe(true);
		expect(serverCards.has(userHash)).toBe(true);
	});
});

describe('401 unknown_user re-ingests the own card, then opens once more', () => {
	it('a server that lost the card gets it back alone, then the same shape opens on a fresh challenge', async () => {
		const { userHash } = await signedInAfterWipe();

		const token = await openSession('dialog_messages');

		expect(token).toBe('tok-dialog_messages-cid-2');
		expect(bearerFor('dialog_messages')).toBe(`Bearer ${token}`);
		expect(log).toEqual([
			'challenge:cid-1',
			'read_session:dialog_messages:cid-1:unknown_user',
			'ingest:user_cards.insert',
			'challenge:cid-2',
			'read_session:dialog_messages:cid-2:ok',
		]);
		expect(serverCards.has(userHash)).toBe(true);
	});

	it('several shapes hitting unknown_user together publish one card', async () => {
		await signedInAfterWipe();

		const tick = () => new Promise((r) => setTimeout(r, 0));
		const messages = openSession('dialog_messages');
		await tick();
		const file = openSession('file');
		const tokens = await Promise.all([messages, file]);

		expect(tokens[0]).toMatch(/^tok-dialog_messages-/);
		expect(tokens[1]).toMatch(/^tok-file-/);
		expect(cardBatches()).toHaveLength(1);
		expect(cardBatches()[0]).toHaveLength(1);
	});

	it('a refused card is reported, stays stored, creates no token and is not sent again', async () => {
		const { userHash } = await signedInAfterWipe();
		refuseCards = true;

		await expect(openSession('dialog_messages')).rejects.toThrow(/validation_failed/);
		expect(bearerFor('dialog_messages')).toBe('');
		const stored = await pendingCardWrites(userHash);
		expect(stored.map((entry) => entry.status)).toEqual(['quarantined']);

		await expect(openSession('file')).rejects.toThrow(/validation_failed/);
		expect(cardBatches()).toHaveLength(1);
		expect(readSessions()).toHaveLength(2);
	});

	it('logout while the recovery waits sends nothing for the former account and opens nothing', async () => {
		const { em, userHash } = await signedInAfterWipe();
		let releaseLock!: () => void;
		let lockHeld!: () => void;
		const held = new Promise<void>((resolve) => { lockHeld = resolve; });
		const holding = withCardLock(userHash, () => new Promise<void>((resolve) => { lockHeld(); releaseLock = resolve; }));
		await held;

		const opening = openSession('dialog_messages');
		await vi.waitFor(() => expect(readSessions()).toHaveLength(1));
		await em.logout();
		releaseLock();
		await holding;

		await expect(opening).resolves.toBeNull();
		await withCardLock(userHash, async () => {});
		expect(cardBatches()).toEqual([]);
		expect(readSessions()).toHaveLength(1);
		expect(bearerFor('dialog_messages')).toBe('');
	});

	it('switching account while the recovery waits sends nothing for the former account', async () => {
		const em = freshManager();
		({ user_hash: userB } = await em.createUserVault({ name: 'B' }));
		({ user_hash: userA } = await em.createUserVault({ name: 'A' }));
		await em.login(userA);
		await withCardLock(userA, async () => {});
		serverCards.delete(userA);
		log = [];
		ingestBatches = [];

		let releaseLock!: () => void;
		let lockHeld!: () => void;
		const held = new Promise<void>((resolve) => { lockHeld = resolve; });
		const holding = withCardLock(userA, () => new Promise<void>((resolve) => { lockHeld(); releaseLock = resolve; }));
		await held;

		const opening = openSession('dialog_messages');
		await vi.waitFor(() => expect(readSessions()).toHaveLength(1));
		await em.login(userB);
		releaseLock();
		await holding;

		await expect(opening).resolves.toBeNull();
		await withCardLock(userA, async () => {});
		expect(cardBatches()).toEqual([]);
		expect(serverCards.has(userA)).toBe(false);
		expect(readSessions()).toHaveLength(1);
		expect(em.currentUserHash).toBe(userB);

		serverCards.delete(userB);
		await expect(openSession('dialog_messages')).resolves.toMatch(/^tok-dialog_messages-/);
		expect(cardBatches().map((batch) => batch.map((m) => m.modified?.user_hash))).toEqual([[userB]]);
	});

	it('a card the server could not take yet is awaited, not asked for again: stream retries cost no challenges until it lands', async () => {
		await signedInAfterWipe();
		unavailableCards = true;
		const tick = () => new Promise((r) => setTimeout(r, 0));

		const first = openSession('dialog_messages');
		await vi.waitFor(() => expect(log).toContain('ingest:503'));
		const restarts = [];
		for (let i = 0; i < 5; i++) { restarts.push(openSession('dialog_messages')); await tick(); }
		await new Promise((r) => setTimeout(r, 50));
		expect(challenges()).toHaveLength(1);
		expect(cardBatches()).toHaveLength(1);

		unavailableCards = false; // the outbox's next scheduled attempt delivers it
		const tokens = await Promise.all([first, ...restarts]);

		expect(tokens[0]).toMatch(/^tok-dialog_messages-/);
		expect(new Set(tokens).size).toBe(1);
		expect(cardBatches()).toHaveLength(2);
		expect(challenges()).toHaveLength(2);
		expect(readSessions().at(-1)).toMatch(/:ok$/);
	}, 20_000);
});

describe('a card waiting for delivery when the session ends', () => {
	it('logout ends the wait at once: no token, no retry open, no later card for the former account', async () => {
		const { em } = await signedInAfterWipe();
		unavailableCards = true;

		const opening = openSession('dialog_messages');
		await vi.waitFor(() => expect(log).toContain('ingest:503'));
		const loggedOutAt = Date.now();
		await em.logout();

		await expect(opening).resolves.toBeNull();
		expect(Date.now() - loggedOutAt).toBeLessThan(1_000);
		unavailableCards = false;
		await new Promise((r) => setTimeout(r, 6_500)); // past the card's scheduled retry
		expect(cardBatches()).toHaveLength(1);
		expect(readSessions()).toHaveLength(1);
		expect(bearerFor('dialog_messages')).toBe('');
	}, 20_000);
});

describe('a direct login(B) after A, without logout, ends A\'s read sessions', () => {
	const twoAccountsSignedInAsA = async () => {
		const em = freshManager();
		({ user_hash: userB } = await em.createUserVault({ name: 'B' }));
		({ user_hash: userA } = await em.createUserVault({ name: 'A' }));
		await em.login(userA);
		log = [];
		return em;
	};

	it('A\'s token is gone once B is signed in, and B opens its own session', async () => {
		const em = await twoAccountsSignedInAsA();
		const tokenA = await openSession('dialog_messages');
		expect(bearerFor('dialog_messages')).toBe(`Bearer ${tokenA}`);

		await em.login(userB);

		expect(bearerFor('dialog_messages')).toBe('');
		const tokenB = await openSession('dialog_messages');
		expect(tokenB).not.toBe(tokenA);
		expect(log.filter((line) => line.startsWith('read_session_request:'))).toEqual(['read_session_request:A', 'read_session_request:B']);
	});

	it('A\'s /read_session answer arriving after B is active stores no token', async () => {
		const em = await twoAccountsSignedInAsA();
		let answer!: () => void;
		holdReadSession = new Promise<void>((resolve) => { answer = resolve; });

		const openingA = openSession('dialog_messages');
		await vi.waitFor(() => expect(log).toContain('read_session_request:A'));
		await em.login(userB);
		holdReadSession = null;
		answer();

		await expect(openingA).resolves.toBeNull();
		expect(bearerFor('dialog_messages')).toBe('');
		const tokenB = await openSession('dialog_messages');
		expect(bearerFor('dialog_messages')).toBe(`Bearer ${tokenB}`);
		expect(log.filter((line) => line.startsWith('read_session_request:'))).toEqual(['read_session_request:A', 'read_session_request:B']);
	});
});
