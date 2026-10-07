import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const em = vi.hoisted(() => ({
	isAuth: true,
	currentUserHash: 'u_' + 'a'.repeat(128) as string | null,
	signed: [] as unknown[],
	signature: new Uint8Array([1, 2, 3, 4]),
	async signChallenge(msg: unknown) {
		this.signed.push(msg);
		return this.signature;
	},
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => em },
}));

const USER_A = 'u_' + 'a'.repeat(128);
const USER_B = 'u_' + 'b'.repeat(128);
const CHALLENGE = '0f'.repeat(16) + 'a1'.repeat(16); // 64 lowercase hex, like Base.encode16(case: :lower)

interface Recorded {
	url: string;
	authorization: string | null;
	body: any;
	signal: AbortSignal | null | undefined;
}

let requests: Recorded[];

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, rec: Recorded) => Response | Promise<Response>;

const installFetch = (handler: Handler) => {
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		const rec: Recorded = {
			url,
			authorization: new Headers(init?.headers).get('authorization'),
			body: init?.body ? JSON.parse(String(init.body)) : null,
			signal: init?.signal,
		};
		requests.push(rec);
		return handler(url, rec);
	});
};

let tokenSeq = 0;
const sessionEndpoints = (url: string, rec: Recorded): Response | null => {
	if (url.endsWith('/challenge')) return json(200, { challenge_id: `cid-${requests.length}`, challenge: CHALLENGE, expires_in: 60 });
	if (url.endsWith('/read_session')) {
		return json(200, { token: `tok-${rec.body.shape}-${++tokenSeq}`, shape: rec.body.shape, expires_in: 300 });
	}
	return null;
};

const challenges = () => requests.filter((r) => r.url.endsWith('/challenge'));
const opens = () => requests.filter((r) => r.url.endsWith('/read_session'));

const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
};

const load = async () => {
	vi.resetModules();
	const rs = await import('@/lib/data/readSession');
	const gate = await import('@/lib/data/accessGate');
	return { ...rs, ...gate };
};

beforeEach(() => {
	requests = [];
	tokenSeq = 0;
	em.isAuth = true;
	em.currentUserHash = USER_A;
	em.signed = [];
	em.signature = new Uint8Array([1, 2, 3, 4]);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});


describe('A. challenge and session opening', () => {
	it('A1 signs the UTF-8 bytes of the hex challenge string, not a string or atob() bytes', async () => {
		const { openSession } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		await openSession('user_card');

		expect(em.signed).toHaveLength(1);
		expect(em.signed[0]).toBeInstanceOf(Uint8Array);
		expect(em.signed[0]).toEqual(new TextEncoder().encode(CHALLENGE));
		expect((em.signed[0] as Uint8Array).length).toBe(64);
	});

	it('A2 sends the signature as unpadded Base64 (short and real ML-DSA-87 length)', async () => {
		const { openSession, clearSessions } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		await openSession('user_card');
		expect(opens()[0].body.signature).toBe('AQIDBA'); // padded form is AQIDBA==

		clearSessions();
		em.signature = new Uint8Array(4627).fill(0xfb); // 4627 % 3 = 1 → two '=' when padded
		await openSession('file');
		const sig = opens()[1].body.signature as string;
		expect(sig).not.toContain('=');
		expect(sig).toMatch(/^[A-Za-z0-9+/]+$/);
		expect(Buffer.from(sig, 'base64')).toEqual(Buffer.from(em.signature));
	});

	it('A3 an unauthenticated client calls neither /challenge nor /read_session', async () => {
		const { openSession, bearerFor } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);
		em.isAuth = false;

		await expect(openSession('user_card')).resolves.toBeNull();
		expect(requests).toEqual([]);
		expect(bearerFor('user_card')).toBe('');
	});

	it('A4 a missing currentUserHash opens no session and sends nothing', async () => {
		const { openSession } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);
		em.currentUserHash = null;

		await expect(openSession('user_card')).resolves.toBeNull();
		expect(requests).toEqual([]);
	});

	it('A5 concurrent opens for one shape share one /challenge and one /read_session', async () => {
		const { openSession, bearerFor } = await load();
		const gate = deferred<void>();
		installFetch(async (url, rec) => {
			if (url.endsWith('/read_session')) await gate.promise;
			return sessionEndpoints(url, rec)!;
		});

		const calls = [openSession('dialog_messages'), openSession('dialog_messages'), openSession('dialog_messages')];
		await new Promise((r) => setTimeout(r, 10));
		gate.resolve();
		const tokens = await Promise.all(calls);

		expect(challenges()).toHaveLength(1);
		expect(opens()).toHaveLength(1);
		expect(new Set(tokens)).toEqual(new Set(['tok-dialog_messages-1']));
		expect(bearerFor('dialog_messages')).toBe('Bearer tok-dialog_messages-1');
	});

	it('A6 concurrent opens for different shapes stay independent', async () => {
		const { openSession, bearerFor } = await load();
		const gate = deferred<void>();
		installFetch(async (url, rec) => {
			if (url.endsWith('/read_session')) await gate.promise;
			return sessionEndpoints(url, rec)!;
		});

		const cardP = openSession('user_card');
		await new Promise((r) => setTimeout(r, 0));
		const fileP = openSession('file');
		await new Promise((r) => setTimeout(r, 10));
		expect(opens()).toHaveLength(2);
		gate.resolve();
		const [card, file] = await Promise.all([cardP, fileP]);

		expect(challenges()).toHaveLength(2);
		expect(opens().map((o) => o.body.shape).sort()).toEqual(['file', 'user_card']);
		expect(card).toMatch(/^tok-user_card-/);
		expect(file).toMatch(/^tok-file-/);
		expect(bearerFor('user_card')).toBe(`Bearer ${card}`);
		expect(bearerFor('file')).toBe(`Bearer ${file}`);
	});

	it('A7 400 unknown_shape returns no session', async () => {
		const { openSession, bearerFor, isShapeBlocked } = await load();
		installFetch((url, rec) =>
			url.endsWith('/read_session') ? json(400, { error: 'unknown_shape' }) : sessionEndpoints(url, rec)!);

		await expect(openSession('no_such_shape')).resolves.toBeNull();
		expect(bearerFor('no_such_shape')).toBe('');
		expect(isShapeBlocked('no_such_shape')).toBe(false);
	});

	it.each([
		['invalid_signature', { error: 'invalid_signature' }],
		['unknown_user', { error: 'unknown_user' }],
		['expired challenge', { error: 'Invalid or expired challenge' }],
	])('A8 401 %s returns no session and does not block the shape', async (_name, body) => {
		const { openSession, bearerFor, isShapeBlocked } = await load();
		installFetch((url, rec) => (url.endsWith('/read_session') ? json(401, body) : sessionEndpoints(url, rec)!));

		await expect(openSession('user_card')).resolves.toBeNull();
		expect(bearerFor('user_card')).toBe('');
		expect(isShapeBlocked('user_card')).toBe(false);
		expect(opens()).toHaveLength(1);
	});

	it('A9 403 not_in_trust_chain returns no session and marks the shape blocked', async () => {
		const { openSession, bearerFor, isShapeBlocked, resetGate } = await load();
		installFetch((url, rec) =>
			url.endsWith('/read_session') ? json(403, { error: 'not_in_trust_chain', max_depth: 3 }) : sessionEndpoints(url, rec)!);

		await expect(openSession('file')).resolves.toBeNull();
		expect(bearerFor('file')).toBe('');
		expect(isShapeBlocked('file')).toBe(true);
		expect(isShapeBlocked('user_card')).toBe(false);
		resetGate();
	});

	it('A10 a successful open unblocks a previously blocked shape', async () => {
		const { openSession, isShapeBlocked, markShapeBlocked, resetGate } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);
		markShapeBlocked('file');
		expect(isShapeBlocked('file')).toBe(true);

		await openSession('file');
		expect(isShapeBlocked('file')).toBe(false);
		resetGate();
	});

	it('A11 tokens are isolated by shape', async () => {
		const { openSession, bearerFor, hasValidToken } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		const card = await openSession('user_card');
		const file = await openSession('file');

		expect(bearerFor('user_card')).toBe(`Bearer ${card}`);
		expect(bearerFor('file')).toBe(`Bearer ${file}`);
		expect(card).not.toBe(file);
		for (const other of ['dialog_messages', 'file_chunk', 'user_storage', 'user_cards', 'files']) {
			expect(bearerFor(other)).toBe('');
			expect(hasValidToken(other)).toBe(false);
		}
	});

	it('A12 a token is unavailable after its local expiry', async () => {
		vi.useFakeTimers();
		const { openSession, bearerFor, hasValidToken } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		await openSession('user_card');
		const t0 = Date.now();
		vi.setSystemTime(t0 + 299_000); // moves the clock without firing the renewal timer
		expect(bearerFor('user_card')).toBe('Bearer tok-user_card-1');
		vi.setSystemTime(t0 + 300_000);
		expect(bearerFor('user_card')).toBe('');
		expect(hasValidToken('user_card')).toBe(false);
	});

	it('A13 renewal happens 60 s before expiry and replaces the token', async () => {
		vi.useFakeTimers();
		const { openSession, bearerFor } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		await openSession('user_card');
		await vi.advanceTimersByTimeAsync(239_000);
		expect(opens()).toHaveLength(1);
		expect(bearerFor('user_card')).toBe('Bearer tok-user_card-1');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(opens()).toHaveLength(2);
		expect(bearerFor('user_card')).toBe('Bearer tok-user_card-2');

		// The renewed entry schedules its own renewal.
		await vi.advanceTimersByTimeAsync(240_000);
		expect(opens()).toHaveLength(3);
		expect(bearerFor('user_card')).toBe('Bearer tok-user_card-3');
	});

	it('A14 clearSessions() cancels renewal: no later timer reopens a session', async () => {
		vi.useFakeTimers();
		const { openSession, bearerFor, clearSessions } = await load();
		installFetch((url, rec) => sessionEndpoints(url, rec)!);

		await openSession('user_card');
		await openSession('file');
		clearSessions();
		await vi.advanceTimersByTimeAsync(3_600_000);

		expect(opens()).toHaveLength(2);
		expect(challenges()).toHaveLength(2);
		expect(bearerFor('user_card')).toBe('');
		expect(bearerFor('file')).toBe('');
		expect(vi.getTimerCount()).toBe(0);
	});
});

const SERVER_TABLE_SHAPES: Record<string, string> = {
	user_cards: 'user_card',
	user_storage: 'user_storage',
	dialog_messages: 'dialog_messages',
	dialog_messages_versions: 'dialog_messages',
	files: 'file',
	file_chunks: 'file_chunk',
	zz_audit_table: 'zz_audit_shape', // invented: cannot be in any client-side map
};

const gatedServer = (opts: { shapeReply?: (table: string, rec: Recorded) => Response | null } = {}): Handler => {
	const issued = new Map<string, string>(); // token -> shape
	return (url, rec) => {
		if (url.endsWith('/read_session')) {
			const res = sessionEndpoints(url, rec)!;
			issued.set(`tok-${rec.body.shape}-${tokenSeq}`, rec.body.shape);
			return res;
		}
		const ep = sessionEndpoints(url, rec);
		if (ep) return ep;
		const table = new URL(url, 'http://x').searchParams.get('table')!;
		const custom = opts.shapeReply?.(table, rec);
		if (custom) return custom;
		const shape = SERVER_TABLE_SHAPES[table];
		const token = rec.authorization?.replace(/^Bearer /, '') ?? '';
		if (issued.get(token) === shape) return json(200, []);
		return json(401, { error: 'read_session_required', shape });
	};
};

const shapeReads = (table: string) => requests.filter((r) => r.url.includes(`/shapes?table=${table}&`));

describe('B. canonical table-to-shape association (readShapeOnce)', () => {
	it.each([
		['user_cards', 'user_card'],
		['dialog_messages_versions', 'dialog_messages'],
		['files', 'file'],
		['file_chunks', 'file_chunk'],
		['user_storage', 'user_storage'],
	])('B1 %s → %s: 401 names the shape, the retry carries that shape\'s token', async (table, shape) => {
		const { bearerFor } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await expect(readShapeOnce(table, "x = 'y'")).resolves.toEqual([]);

		expect(opens().map((o) => o.body.shape)).toEqual([shape]);
		expect(shapeReads(table).map((r) => r.authorization)).toEqual([null, `Bearer tok-${shape}-1`]);
		expect(bearerFor(table)).toBe(`Bearer tok-${shape}-1`);
		expect(bearerFor(shape)).toBe(`Bearer tok-${shape}-1`);
	});

	it('B2 the association is learned from the backend 401, not a hardcoded map', async () => {
		const { bearerFor, openSession } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await expect(readShapeOnce('zz_audit_table', "x = 'y'")).resolves.toEqual([]);
		expect(opens().map((o) => o.body.shape)).toEqual(['zz_audit_shape']);
		expect(bearerFor('zz_audit_table')).toBe('Bearer tok-zz_audit_shape-1');

		await openSession('user_card');
		expect(bearerFor('user_card')).toMatch(/^Bearer tok-user_card-/);
		expect(bearerFor('user_cards')).toBe('');
	});

	it('B3 two tables of one shape end up on the same token', async () => {
		const { bearerFor } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('dialog_messages', "x = 'y'");
		await readShapeOnce('dialog_messages_versions', "x = 'y'");

		expect(bearerFor('dialog_messages')).not.toBe('');
		expect(bearerFor('dialog_messages_versions')).toBe(bearerFor('dialog_messages'));
		const before = opens().length;
		await readShapeOnce('dialog_messages', "x = 'y'");
		await readShapeOnce('dialog_messages_versions', "x = 'y'");
		expect(opens()).toHaveLength(before);
	});

	it('B4 different tables/shapes never receive each other\'s tokens', async () => {
		const { bearerFor } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('user_cards', "x = 'y'");
		await readShapeOnce('files', "x = 'y'");
		await readShapeOnce('user_cards', "x = 'y'");
		await readShapeOnce('files', "x = 'y'");

		expect(bearerFor('user_cards')).toMatch(/^Bearer tok-user_card-/);
		expect(bearerFor('files')).toMatch(/^Bearer tok-file-/);
		for (const r of shapeReads('user_cards')) expect(r.authorization ?? '').not.toMatch(/tok-file-/);
		for (const r of shapeReads('files')) expect(r.authorization ?? '').not.toMatch(/tok-user_card-/);
		expect(bearerFor('dialog_messages_versions')).toBe('');
		expect(bearerFor('file_chunks')).toBe('');
	});

	it('B5 clearSessions() clears tokens and learned associations', async () => {
		const { bearerFor, clearSessions, openSession } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('user_cards', "x = 'y'");
		expect(bearerFor('user_cards')).not.toBe('');
		clearSessions();
		expect(bearerFor('user_cards')).toBe('');
		expect(bearerFor('user_card')).toBe('');

		await openSession('user_card');
		expect(bearerFor('user_card')).not.toBe('');
		expect(bearerFor('user_cards')).toBe('');
	});

	it('B6 after clearing, the next read starts without Authorization and learns the shape again', async () => {
		const { bearerFor, clearSessions } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('user_cards', "x = 'y'");
		clearSessions();
		await expect(readShapeOnce('user_cards', "x = 'y'")).resolves.toEqual([]);

		expect(shapeReads('user_cards').map((r) => r.authorization))
			.toEqual([null, 'Bearer tok-user_card-1', null, 'Bearer tok-user_card-2']);
		expect(bearerFor('user_cards')).toBe('Bearer tok-user_card-2');
	});

	it.each([
		['another 401 error', () => json(401, { error: 'unauthorized' })],
		['read_session_required without shape', () => json(401, { error: 'read_session_required' })],
		['non-JSON body', () => new Response('<html>401</html>', { status: 401 })],
		['empty body', () => new Response(null, { status: 401 })],
	])('B7 a 401 with %s opens no session and surfaces the error', async (_name, reply) => {
		await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer({ shapeReply: () => reply() }));

		await expect(readShapeOnce('user_cards', "x = 'y'")).rejects.toThrow('user_cards read failed: HTTP 401');
		expect(challenges()).toHaveLength(0);
		expect(opens()).toHaveLength(0);
		expect(shapeReads('user_cards')).toHaveLength(1);
	});

	it('B8 a second 401 is an error, not a loop: one open, two reads', async () => {
		await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer({ shapeReply: (table) => json(401, { error: 'read_session_required', shape: SERVER_TABLE_SHAPES[table] }) }));

		await expect(readShapeOnce('user_cards', "x = 'y'")).rejects.toThrow('HTTP 401');
		expect(shapeReads('user_cards')).toHaveLength(2);
		expect(opens()).toHaveLength(1);
	});

	it('B9 the caller\'s AbortSignal is passed to the first request and the retry', async () => {
		await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());
		const controller = new AbortController();

		await readShapeOnce('user_cards', "x = 'y'", controller.signal);

		const reads = shapeReads('user_cards');
		expect(reads).toHaveLength(2);
		expect(reads[0].signal).toBe(controller.signal);
		expect(reads[1].signal).toBe(controller.signal);
	});
});

describe('F. session cleanup and isolation', () => {
	it('F1 clearSessions() removes every token, for shapes and for learned tables', async () => {
		const { bearerFor, hasValidToken, clearSessions, openSession } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('user_cards', "x = 'y'");
		await readShapeOnce('dialog_messages_versions', "x = 'y'");
		await openSession('file_chunk');
		await openSession('file');
		const names = ['user_card', 'user_cards', 'dialog_messages', 'dialog_messages_versions', 'file_chunk', 'file'];
		for (const n of names) expect(bearerFor(n)).not.toBe('');

		clearSessions();
		for (const n of names) {
			expect(bearerFor(n)).toBe('');
			expect(hasValidToken(n)).toBe(false);
		}
	});

	it('F2 tokens stay in memory: no Web Storage, IndexedDB, Cache API, URL or console output carries them', async () => {
		vi.useFakeTimers();
		const touched: string[] = [];
		const trap = (name: string) => new Proxy({}, {
			get: (_t, prop) => { touched.push(`${name}.${String(prop)}`); return () => undefined; },
		});
		for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) vi.stubGlobal(name, trap(name));
		const logged: string[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
			.map((m) => vi.spyOn(console, m).mockImplementation((...args) => { logged.push(args.map(String).join(' ')); }));

		const { openSession } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());
		await readShapeOnce('user_cards', "x = 'y'");
		await openSession('file_chunk');
		await vi.advanceTimersByTimeAsync(240_000); // renewal of both

		spies.forEach((s) => s.mockRestore());
		expect(opens()).toHaveLength(4); // user_card + file_chunk, each opened and renewed
		expect(touched).toEqual([]);
		for (const r of requests) expect(r.url).not.toMatch(/tok-/);
		for (const line of logged) expect(line).not.toMatch(/tok-/);
	});

	it('F3 after reset, the next identity opens its own session; the old token is never sent', async () => {
		const { clearSessions } = await load();
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		installFetch(gatedServer());

		await readShapeOnce('user_cards', "x = 'y'");
		const tokenA = 'Bearer tok-user_card-1';
		clearSessions();
		em.currentUserHash = USER_B;
		await readShapeOnce('user_cards', "x = 'y'");

		expect(opens().map((o) => o.body.user_hash)).toEqual([USER_A, USER_B]);
		const afterReset = shapeReads('user_cards').slice(2);
		expect(afterReset.map((r) => r.authorization)).toEqual([null, 'Bearer tok-user_card-2']);
		expect(afterReset.some((r) => r.authorization === tokenA)).toBe(false);
	});

	it('F4 a session open still in flight at logout does not leave its token behind', async () => {
		const { openSession, bearerFor, clearSessions } = await load();
		const gate = deferred<void>();
		installFetch(async (url, rec) => {
			if (url.endsWith('/read_session')) await gate.promise;
			return sessionEndpoints(url, rec)!;
		});

		const pendingA = openSession('user_card'); // identity A
		await new Promise((r) => setTimeout(r, 10));
		expect(opens()).toHaveLength(1);

		clearSessions(); // logout of A
		em.currentUserHash = USER_B; // B signs in
		gate.resolve(); // A's /read_session answers late
		await pendingA;

		expect(bearerFor('user_card')).toBe('');
	});

	it('F5 a renewal in flight at logout does not leave its token or a new renewal timer behind', async () => {
		vi.useFakeTimers();
		const { openSession, bearerFor, clearSessions } = await load();
		let holdRenewal: ReturnType<typeof deferred<void>> | null = null;
		installFetch(async (url, rec) => {
			if (url.endsWith('/read_session') && holdRenewal) await holdRenewal.promise;
			return sessionEndpoints(url, rec)!;
		});

		await openSession('user_card');
		holdRenewal = deferred<void>();
		await vi.advanceTimersByTimeAsync(240_000); // renewal starts and blocks
		expect(opens()).toHaveLength(2);

		clearSessions();
		holdRenewal.resolve();
		await vi.advanceTimersByTimeAsync(0);

		expect(bearerFor('user_card')).toBe('');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('F6 an open from before logout does not break single-flight for the next identity', async () => {
		const { openSession, clearSessions } = await load();
		const gates: Array<ReturnType<typeof deferred<void>>> = [];
		installFetch(async (url, rec) => {
			if (url.endsWith('/read_session')) {
				const g = deferred<void>();
				gates.push(g);
				await g.promise;
			}
			return sessionEndpoints(url, rec)!;
		});
		const tick = () => new Promise((r) => setTimeout(r, 10));

		const staleA = openSession('user_card');
		await tick();
		clearSessions();
		em.currentUserHash = USER_B;
		const firstB = openSession('user_card');
		await tick();
		expect(opens()).toHaveLength(2);

		gates[0].resolve(); // A's open settles; its cleanup must not drop B's in-flight entry
		await staleA;
		const secondB = openSession('user_card'); // should join B's open
		await tick();

		expect(opens()).toHaveLength(2);
		gates.slice(1).forEach((g) => g.resolve());
		await Promise.all([firstB, secondB]);
	});

	it('F7 logout while /challenge is in flight: the stale open resolves to null without signing', async () => {
		vi.useFakeTimers();
		const { openSession, bearerFor, clearSessions } = await load();
		const challengeGate = deferred<void>();
		installFetch(async (url, rec) => {
			if (url.endsWith('/challenge')) await challengeGate.promise;
			return sessionEndpoints(url, rec)!;
		});
		
		const realSign = em.signChallenge;
		let signsAfterReset = 0;
		let loggedOut = false;
		em.signChallenge = async function (msg: unknown) {
			if (loggedOut) {
				signsAfterReset++;
				throw new Error('Not authenticated or secret key not loaded');
			}
			return realSign.call(this, msg);
		};
		try {
			const staleA = openSession('user_card').then(
				(token) => ({ ok: true as const, token }),
				(error: Error) => ({ ok: false as const, error: error.message }),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(challenges()).toHaveLength(1);

			clearSessions(); // logout of A while /challenge is pending
			loggedOut = true;
			em.isAuth = false;
			em.currentUserHash = USER_B;
			challengeGate.resolve();
			const outcome = await staleA;
			await vi.advanceTimersByTimeAsync(0);

			expect(outcome).toEqual({ ok: true, token: null });
			expect(signsAfterReset).toBe(0);
			expect(em.signed).toEqual([]);
			expect(opens()).toHaveLength(0);
			expect(bearerFor('user_card')).toBe('');
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			em.signChallenge = realSign;
		}
	});
});
