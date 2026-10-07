import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import { createBrowserWASQLitePersistence } from '@tanstack/browser-db-sqlite-persistence';

const em = vi.hoisted(() => Object.assign(new EventTarget(), {
	isAuth: true,
	currentUserHash: 'u_' + 'a'.repeat(128) as string | null,
	signChallenge: async () => new Uint8Array([1, 2, 3]),
}));
const ME = 'u_' + 'a'.repeat(128);
const setAuth = (signedIn: boolean) => {
	em.isAuth = signedIn;
	em.currentUserHash = signedIn ? ME : null;
	em.dispatchEvent(new CustomEvent('authChange', { detail: { isAuthenticated: signedIn, userHash: em.currentUserHash } }));
};
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/lib/data/userCardsCache', () => ({ mirrorUserCards: () => () => {} }));

const persistenceRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/data/persistence', () => ({ getPersistence: () => persistenceRef.current }));

const openWaSqliteDatabase = async () => {
	const module = await SQLiteESMFactory({ wasmBinary: readFileSync('node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite.wasm') });
	const sqlite3 = SQLite.Factory(module);
	const db = await sqlite3.open_v2(':memory:');
	const bindable = (v: unknown) =>
		v === null || v === undefined ? null
			: typeof v === 'boolean' ? (v ? 1 : 0)
				: typeof v === 'number' ? (Number.isFinite(v) ? v : null)
					: v;
	return {
		async execute(sql: string, params: unknown[] = []) {
			const rows: Record<string, unknown>[] = [];
			let bound = false;
			for await (const stmt of sqlite3.statements(db, sql)) {
				if (params.length > 0) {
					if (bound) throw new Error('parameter binding supports a single statement');
					sqlite3.bind_collection(stmt, params.map(bindable) as never);
					bound = true;
				}
				let columns = [...sqlite3.column_names(stmt)];
				for (;;) {
					const rc = await sqlite3.step(stmt);
					if (rc === SQLite.SQLITE_ROW) {
						if (columns.length === 0) columns = [...sqlite3.column_names(stmt)];
						const values = sqlite3.row(stmt);
						const row: Record<string, unknown> = {};
						columns.forEach((c, i) => { if (c) row[c] = values[i]; });
						rows.push(row);
						continue;
					}
					if (rc === SQLite.SQLITE_DONE) break;
					throw new Error(`step returned ${rc}`);
				}
			}
			return rows;
		},
		async close() { await sqlite3.close(db); },
	};
};


interface Recorded { path: string; authorization: string | null; live: boolean; status?: number }
let requests: Recorded[];
let trusted: boolean;
let mode: 'trust' | 'open';
const started: Array<{ cleanup(): Promise<void> }> = [];
const issued = new Set<string>();
let heldLive: Array<() => void>;
let tokenSeq: number;
let handle = 'h-cards-0';
let handleSeq = 0;

const CARD = { user_hash: 'u_' + 'a'.repeat(128), name: 'Reader', sign_b64: 'x' };
const electricHeaders = (extra: Record<string, string> = {}) => ({
	'content-type': 'application/json',
	'electric-handle': handle,
	'electric-offset': '0_0',
	'electric-cursor': String(handleSeq),
	'electric-up-to-date': '',
	...extra,
});
const json = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
	new Response(JSON.stringify(body), { status, headers });

const installServer = () => {
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input), 'http://app.test');
		const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
		const rec: Recorded = { path: url.pathname.replace(/^\/api/, ''), authorization, live: url.searchParams.get('live') === 'true' };
		requests.push(rec);
		const reply = (r: Response) => { rec.status = r.status; return r; };

		if (rec.path === '/challenge') return reply(json(200, { challenge_id: 'cid', challenge: 'ab'.repeat(32), expires_in: 60 }));
		if (rec.path === '/read_session') {
			if (!trusted) return reply(json(403, { error: 'not_in_trust_chain', max_depth: 3 }));
			const token = `tok-${++tokenSeq}`;
			issued.add(token);
			return reply(json(200, { token, shape: 'user_card', expires_in: 300 }));
		}
		if (rec.path === '/shapes' && url.searchParams.get('table') === 'user_cards') {
			if (mode === 'trust' && !issued.has(authorization?.replace(/^Bearer /, '') ?? '')) {
				return reply(json(401, { error: 'read_session_required', shape: 'user_card' }));
			}
			if (rec.live) {
				await new Promise<void>((resolve, reject) => {
					heldLive.push(resolve);
					init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				});
				return reply(json(200, [{ headers: { control: 'up-to-date' } }], electricHeaders()));
			}
			return reply(json(200, [
				{ key: `"${CARD.user_hash}"`, value: CARD, headers: { operation: 'insert' } },
				{ headers: { control: 'up-to-date' } },
			], electricHeaders({ 'electric-schema': JSON.stringify({ user_hash: { type: 'text' }, name: { type: 'text' }, sign_b64: { type: 'text' } }) })));
		}
		throw new Error(`unexpected fetch ${url}`);
	});
};

const waitFor = async (cond: () => boolean, ms = 4000, what = 'condition') => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
};
const releaseLive = () => heldLive.splice(0).forEach((resolve) => resolve());
const waitWhilePolling = (cond: () => boolean, ms: number, what: string) =>
	waitFor(() => { releaseLive(); return cond(); }, ms, what);

beforeEach(() => {
	vi.resetModules();
	requests = [];
	heldLive = [];
	issued.clear();
	tokenSeq = 0;
	trusted = true;
	mode = 'trust';
	em.isAuth = true;
	em.currentUserHash = ME;
	handle = `h-cards-${++handleSeq}`;
	installServer();
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(started.splice(0).map((c) => c.cleanup().catch(() => {})));
	releaseLive();
	vi.unstubAllGlobals();
	persistenceRef.current = null;
});

const startLiveUserCards = async (persisted: boolean) => {
	if (persisted) persistenceRef.current = createBrowserWASQLitePersistence({ database: await openWaSqliteDatabase() as never });
	const { getUserCardsCollection } = await import('@/lib/data/collections');
	const { clearSessions } = await import('@/lib/data/readSession');
	const gate = await import('@/lib/data/accessGate');
	const { isLiveNow, whenLive } = await import('@/lib/data/shapeLink');
	const coll = getUserCardsCollection();
	started.push(coll);
	const live = whenLive(coll as never);
	void coll.preload();
	await Promise.race([live, waitFor(() => false, 4000, 'collection live')]);
	await waitFor(() => heldLive.length > 0, 4000, 'live long-poll');
	expect(coll.toArray.map((r: any) => r.user_hash)).toEqual([CARD.user_hash]);
	expect(isLiveNow(coll as never)).toBe(true);
	return { coll, clearSessions, gate, isLive: () => isLiveNow(coll as never) };
};

const revokeAndRelogin = async (s: Awaited<ReturnType<typeof startLiveUserCards>>) => {
	const from = requests.length;
	trusted = false;
	s.clearSessions();
	releaseLive();
	await waitFor(() => s.gate.isShapeBlocked('user_card'), 4000, 'user_card blocked').catch(() => {});
	await new Promise((r) => setTimeout(r, 100));
	return requests.slice(from);
};

describe.each([
	['persisted (wa-sqlite)', true],
	['in-memory', false],
])('revoked read access is detected — %s collection', (_label, persisted) => {
	it('live → revoke → logout/login → 401 → /challenge, /read_session 403 → blocked, banner on, not live', async () => {
		const s = await startLiveUserCards(persisted);
		const after = await revokeAndRelogin(s);

		expect(after.some((r) => r.path === '/shapes' && r.status === 401)).toBe(true);
		expect(after.filter((r) => r.path === '/challenge')).toHaveLength(1);
		expect(after.filter((r) => r.path === '/read_session').map((r) => r.status)).toEqual([403]);
		expect(s.gate.isShapeBlocked('user_card')).toBe(true);
		expect(s.gate.hasBlockedShapes()).toBe(true); // AccessGateBanner's visibility
		expect(s.isLive()).toBe(false);

		s.gate.resetGate();
		await s.coll.cleanup();
	});

	it('blocked, then approved: "Check again" makes the collection live again with a token', async () => {
		const s = await startLiveUserCards(persisted);
		await revokeAndRelogin(s);
		expect(s.isLive()).toBe(false);

		trusted = true; // owner vouches again
		s.gate.probeAllBlocked();
		await waitWhilePolling(() => s.isLive(), 6000, 'live again');

		expect(s.gate.hasBlockedShapes()).toBe(false);
		expect(requests.filter((r) => r.path === '/shapes').at(-1)?.authorization).toMatch(/^Bearer tok-\d+$/);
		s.gate.resetGate();
		await s.coll.cleanup();
	}, 15_000);

	it('blocked, then trust → open: "Check again" makes the collection live again without a token', async () => {
		const s = await startLiveUserCards(persisted);
		await revokeAndRelogin(s);
		expect(s.isLive()).toBe(false);

		mode = 'open'; // /read_session keeps answering 403
		s.gate.probeAllBlocked();
		await waitWhilePolling(() => s.isLive(), 6000, 'live again');

		expect(s.gate.hasBlockedShapes()).toBe(false);
		const shapes = requests.filter((r) => r.path === '/shapes');
		expect(shapes.at(-1)?.authorization ?? '').toBe(''); // Electric sends the resolver's '' — no token
		expect(shapes.at(-1)?.status).toBe(200);
		s.gate.resetGate();
		await s.coll.cleanup();
	}, 15_000);

	it('logged out: one 401, no /challenge, no retry loop; after login the normal flow runs once', async () => {
		const s = await startLiveUserCards(persisted);
		const from = requests.length;
		trusted = false;
		s.clearSessions();
		setAuth(false); // logout
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		releaseLive();
		for (let i = 0; i < 300; i++) await vi.advanceTimersByTimeAsync(10_000);
		const loggedOut = requests.slice(from);
		vi.useRealTimers();

		expect(loggedOut.filter((r) => r.path === '/challenge')).toHaveLength(0);
		expect(loggedOut.filter((r) => r.path === '/shapes' && r.status === 401)).toHaveLength(1);

		const atLogin = requests.length;
		setAuth(true); // login
		await waitFor(() => s.gate.isShapeBlocked('user_card'), 5000, 'blocked after login').catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		const afterLogin = requests.slice(atLogin);

		expect(afterLogin.filter((r) => r.path === '/challenge')).toHaveLength(1);
		expect(afterLogin.filter((r) => r.path === '/read_session').map((r) => r.status)).toEqual([403]);
		expect(s.gate.hasBlockedShapes()).toBe(true);
		expect(s.isLive()).toBe(false);
		s.gate.resetGate();
		await s.coll.cleanup();
	}, 30_000);

	it('logged out, then login with access still granted: retries with the Bearer token and stays live', async () => {
		const s = await startLiveUserCards(persisted);
		s.clearSessions();
		setAuth(false);
		releaseLive();
		await waitFor(() => requests.filter((r) => r.status === 401).length >= 1, 4000, 'first 401');
		await new Promise((r) => setTimeout(r, 300));
		expect(requests.filter((r) => r.path === '/challenge')).toHaveLength(1); // session 1 only

		const atLogin = requests.length;
		setAuth(true);
		await waitWhilePolling(() => requests.slice(atLogin).some((r) => r.path === '/shapes' && r.status === 200 && !!r.authorization), 6000, 'retry with token');

		expect(requests.slice(atLogin).filter((r) => r.path === '/read_session').map((r) => r.status)).toEqual([200]);
		expect(s.gate.hasBlockedShapes()).toBe(false);
		await s.coll.cleanup();
	}, 15_000);
});

describe('revoked read access after a warm start from persisted SQLite', () => {
	it('resumed stream → 401 → /challenge, /read_session 403 → blocked, banner on, not live', async () => {
		const database = await openWaSqliteDatabase();

		// Session 1: valid access, rows and resume state land in SQLite.
		persistenceRef.current = createBrowserWASQLitePersistence({ database: database as never });
		{
			const { getUserCardsCollection } = await import('@/lib/data/collections');
			const { whenLive } = await import('@/lib/data/shapeLink');
			const coll = getUserCardsCollection();
			started.push(coll);
			const live = whenLive(coll as never);
			void coll.preload();
			await Promise.race([live, waitFor(() => false, 4000, 'session 1 live')]);
			await waitFor(() => heldLive.length > 0, 4000, 'session 1 long-poll');
			await new Promise((r) => setTimeout(r, 200)); // let the persisted write settle
			releaseLive();
			await coll.cleanup();
		}

		vi.resetModules();
		trusted = false;
		persistenceRef.current = createBrowserWASQLitePersistence({ database: database as never });
		const start = requests.length;
		const { getUserCardsCollection } = await import('@/lib/data/collections');
		const gate = await import('@/lib/data/accessGate');
		const { isLiveNow } = await import('@/lib/data/shapeLink');
		const coll = getUserCardsCollection();
		started.push(coll);
		void coll.preload();

		await waitFor(() => gate.isShapeBlocked('user_card'), 4000, 'user_card blocked').catch(() => {});
		await new Promise((r) => setTimeout(r, 200));

		const after = requests.slice(start);
		expect(after.some((r) => r.path === '/shapes' && r.status === 401)).toBe(true);
		expect(after.filter((r) => r.path === '/challenge')).toHaveLength(1);
		expect(after.filter((r) => r.path === '/read_session').map((r) => r.status)).toEqual([403]);
		expect(gate.isShapeBlocked('user_card')).toBe(true);
		expect(gate.hasBlockedShapes()).toBe(true);
		expect(isLiveNow(coll as never)).toBe(false);

		gate.resetGate();
		await coll.cleanup();
	});
});
