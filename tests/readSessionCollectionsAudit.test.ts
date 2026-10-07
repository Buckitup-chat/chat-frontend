import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchError, ShapeStream } from '@electric-sql/client';

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			isAuth: true,
			currentUserHash: 'u_' + 'a'.repeat(128),
			signChallenge: async () => new Uint8Array([1, 2, 3]),
		}),
	},
}));

const captured: any[] = [];
vi.mock('@tanstack/electric-db-collection', () => ({
	electricCollectionOptions: (opts: any) => {
		captured.push(opts);
		return opts;
	},
	isControlMessage: () => false,
}));
vi.mock('@tanstack/db', () => ({ createCollection: (o: any) => o }));
vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({ persistedCollectionOptions: (o: any) => o }));
vi.mock('../src/lib/data/persistence', () => ({ getPersistence: () => null }));

const DIALOG = 'di_' + 'c'.repeat(128);
const SERVER_TABLE_SHAPES: Record<string, string> = {
	user_cards: 'user_card',
	dialog_keys: 'dialog_keys',
	dialog_messages: 'dialog_messages',
	dialog_messages_versions: 'dialog_messages',
	dialog_message_reactions: 'dialog_message_reactions',
	dialog_message_receipts: 'dialog_message_receipts',
};

interface Recorded { url: string; authorization: string | null; shape?: string }
let requests: Recorded[];
let readSessionReply: (shape: string, n: number) => Response;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const ok = (shape: string, n: number) => json(200, { token: `tok-${shape}-${n}`, shape, expires_in: 300 });

const installServer = () => {
	requests = [];
	let n = 0;
	const issued = new Map<string, string>();
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get('authorization');
		const rec: Recorded = { url, authorization };
		requests.push(rec);
		if (url.includes('/challenge')) return json(200, { challenge_id: 'cid', challenge: 'ab'.repeat(32), expires_in: 60 });
		if (url.includes('/read_session')) {
			const { shape } = JSON.parse(String(init?.body));
			rec.shape = shape;
			const res = readSessionReply(shape, ++n);
			if (res.status === 200) issued.set(`tok-${shape}-${n}`, shape);
			return res;
		}
		const table = new URL(url, 'http://x').searchParams.get('table')!;
		const shape = SERVER_TABLE_SHAPES[table];
		if (issued.get(authorization?.replace(/^Bearer /, '') ?? '') === shape) return json(200, []);
		return json(401, { error: 'read_session_required', shape });
	});
};

const opens = () => requests.filter((r) => r.url.includes('/read_session'));
const optsFor = (table: string) => captured.find((o) => o.shapeOptions?.params?.table === table);

const errorFor = async (table: string, res?: Response) => {
	const url = `/api/shapes?table=${table}&offset=-1`;
	return FetchError.fromResponse(res ?? await fetch(url), url);
};

beforeEach(() => {
	captured.length = 0;
	vi.resetModules();
	readSessionReply = ok;
	installServer();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('C. Electric collection behaviour', () => {
	it('C1 before any 401 the header resolver returns an empty Authorization', async () => {
		const { getUserCardsCollection, getDialogCollections } = await import('@/lib/data/collections');
		getUserCardsCollection();
		getDialogCollections(DIALOG);

		for (const table of Object.keys(SERVER_TABLE_SHAPES)) {
			const opts = optsFor(table);
			expect(opts, table).toBeTruthy();
			expect(typeof opts.shapeOptions.headers.Authorization).toBe('function');
			expect(opts.shapeOptions.headers.Authorization()).toBe('');
		}
		expect(requests).toEqual([]);
	});

	it('C2 onError opens the canonical shape and the header resolver returns its token (every dialog table)', async () => {
		const { getDialogCollections } = await import('@/lib/data/collections');
		getDialogCollections(DIALOG);

		for (const table of Object.keys(SERVER_TABLE_SHAPES).filter((t) => t.startsWith('dialog_'))) {
			const opts = optsFor(table);
			const retry = await opts.shapeOptions.onError(await errorFor(table));
			expect(retry, table).toEqual({});
			expect(opts.shapeOptions.headers.Authorization(), table)
				.toMatch(new RegExp(`^Bearer tok-${SERVER_TABLE_SHAPES[table]}-\\d+$`));
		}
		expect(opens().map((o) => o.shape)).toEqual([
			'dialog_keys', 'dialog_messages', 'dialog_messages', 'dialog_message_reactions', 'dialog_message_receipts',
		]);
	});

	it('C3 a real Electric ShapeStream retries after onError with the new Bearer token', async () => {
		const { getDialogCollections } = await import('@/lib/data/collections');
		getDialogCollections(DIALOG);
		const opts = optsFor('dialog_messages_versions');

		const backend = globalThis.fetch;
		const electricFetch: typeof fetch = async (input, init) => {
			const res = await backend(input as string, init);
			if (res.status !== 200) return res;
			return new Response(JSON.stringify([{ headers: { control: 'up-to-date' } }]), {
				status: 200,
				headers: {
					'content-type': 'application/json',
					'electric-handle': 'h-1',
					'electric-offset': '0_0',
					'electric-schema': '{}',
					'electric-up-to-date': '',
					'electric-cursor': '1',
				},
			});
		};

		const controller = new AbortController();
		const stream = new ShapeStream({
			url: 'http://api.test/api/shapes',
			params: opts.shapeOptions.params,
			headers: opts.shapeOptions.headers,
			onError: opts.shapeOptions.onError,
			fetchClient: electricFetch,
			signal: controller.signal,
		});
		const upToDate = new Promise<void>((resolve) => {
			stream.subscribe((msgs) => {
				if (msgs.some((m: any) => m.headers?.control === 'up-to-date')) resolve();
			});
		});
		await Promise.race([upToDate, new Promise((_, rej) => setTimeout(() => rej(new Error('stream never reached up-to-date')), 3000))]);
		controller.abort();

		const shapeReqs = requests.filter((r) => r.url.includes('table=dialog_messages_versions'));
		expect(shapeReqs[0].authorization ?? '').toBe('');
		expect(shapeReqs[1].authorization).toBe('Bearer tok-dialog_messages-1');
		expect(opens().map((o) => o.shape)).toEqual(['dialog_messages']);
	});

	it('C4 concurrent 401s from collections of one shape share one session open', async () => {
		const { getDialogCollections } = await import('@/lib/data/collections');
		getDialogCollections(DIALOG);
		const messages = optsFor('dialog_messages');
		const versions = optsFor('dialog_messages_versions');

		const [e1, e2] = [await errorFor('dialog_messages'), await errorFor('dialog_messages_versions')];
		const results = await Promise.all([messages.shapeOptions.onError(e1), versions.shapeOptions.onError(e2)]);

		expect(results).toEqual([{}, {}]);
		expect(opens()).toHaveLength(1);
		expect(requests.filter((r) => r.url.includes('/challenge'))).toHaveLength(1);
		expect(messages.shapeOptions.headers.Authorization()).toBe('Bearer tok-dialog_messages-1');
		expect(versions.shapeOptions.headers.Authorization()).toBe('Bearer tok-dialog_messages-1');
	});

	it.each([
		['HTTP 500', () => json(500, { error: 'boom' })],
		['HTTP 400', () => json(400, { message: 'bad where' })],
		['401 with another error', () => json(401, { error: 'unauthorized' })],
	])('C5 a non-session error (%s) takes the existing report path and opens nothing', async (_name, reply) => {
		const { getUserCardsCollection } = await import('@/lib/data/collections');
		const { userCardsShapeLink } = await import('@/lib/data/userCardsLink');
		getUserCardsCollection();
		const opts = optsFor('user_cards');
		expect(userCardsShapeLink.hasFailed()).toBe(false);

		const retry = await opts.shapeOptions.onError(await errorFor('user_cards', reply()));

		expect(retry).toEqual({});
		expect(userCardsShapeLink.hasFailed()).toBe(true);
		expect(opens()).toHaveLength(0);
		expect(requests.filter((r) => r.url.includes('/challenge'))).toHaveLength(0);
	});

	it('C6 a blocked shape waits for approval with bounded probing, then resumes with a token', async () => {
		vi.useFakeTimers();
		readSessionReply = () => json(403, { error: 'not_in_trust_chain', max_depth: 3 });
		const { getUserCardsCollection } = await import('@/lib/data/collections');
		const { isShapeBlocked, resetGate } = await import('@/lib/data/accessGate');
		getUserCardsCollection();
		const opts = optsFor('user_cards');

		let settled: unknown = 'pending';
		void opts.shapeOptions.onError(await errorFor('user_cards')).then((v: unknown) => { settled = v; });
		await vi.advanceTimersByTimeAsync(0);
		expect(isShapeBlocked('user_card')).toBe(true);
		expect(opens()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(14_000);
		expect(opens()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(opens()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(opens()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(opens()).toHaveLength(3);
		expect(settled).toBe('pending'); // the stream is parked, not retrying

		readSessionReply = ok; // owner approves
		await vi.advanceTimersByTimeAsync(1_000);
		expect(opens()).toHaveLength(4);
		expect(isShapeBlocked('user_card')).toBe(false);
		expect(settled).toEqual({});
		expect(opts.shapeOptions.headers.Authorization()).toBe('Bearer tok-user_card-4');
		resetGate();
	});
});

describe('G. parked streams recover when the gate stops requiring a session', () => {
	let mode: 'trust' | 'open';
	let trusted: boolean;

	let serverSeq = 0;

	const installModalServer = () => {
		requests = [];
		let n = 0;
		const handle = `h-${++serverSeq}`;
		const issued = new Set<string>();
		vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
			const url = String(input);
			const authorization = new Headers(init?.headers).get('authorization');
			const rec: Recorded = { url, authorization };
			requests.push(rec);
			if (url.includes('/challenge')) return json(200, { challenge_id: 'cid', challenge: 'ab'.repeat(32), expires_in: 60 });
			if (url.includes('/read_session')) {
				const { shape } = JSON.parse(String(init?.body));
				rec.shape = shape;
				if (!trusted) return json(403, { error: 'not_in_trust_chain', max_depth: 3 });
				const token = `tok-${shape}-${++n}`;
				issued.add(token);
				return json(200, { token, shape, expires_in: 300 });
			}
			const params = new URL(url, 'http://x').searchParams;
			const shape = SERVER_TABLE_SHAPES[params.get('table')!];
			const gated = mode === 'trust';
			if (gated && !issued.has(authorization?.replace(/^Bearer /, '') ?? '')) {
				return json(401, { error: 'read_session_required', shape });
			}
			if (params.get('live') === 'true') {
				await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
			}
			return json(200, [
				{ key: '"u1"', value: { user_hash: 'u1' }, headers: { operation: 'insert' } },
				{ headers: { control: 'up-to-date' } },
			], {
				'electric-handle': handle,
				'electric-offset': '0_0',
				'electric-schema': JSON.stringify({ user_hash: { type: 'text' } }),
				'electric-up-to-date': '',
				'electric-cursor': String(serverSeq),
			});
		});
	};

	const shapeReqs = () => requests.filter((r) => r.url.includes('table=user_cards'));
	const waitFor = async (cond: () => boolean, ms = 3000) => {
		const start = Date.now();
		while (!cond()) {
			if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
			await new Promise((r) => setTimeout(r, 10));
		}
	};

	const startUserCardsStream = async () => {
		const { getUserCardsCollection } = await import('@/lib/data/collections');
		const gate = await import('@/lib/data/accessGate');
		getUserCardsCollection();
		const opts = optsFor('user_cards').shapeOptions;
		const controller = new AbortController();
		const rows: unknown[] = [];
		let upToDate = 0;
		const stream = new ShapeStream({
			url: 'http://api.test/api/shapes',
			params: opts.params,
			headers: opts.headers,
			onError: opts.onError,
			fetchClient: opts.fetchClient,
			signal: controller.signal,
		});
		stream.subscribe((msgs) => {
			for (const m of msgs as any[]) {
				if (m.headers?.control === 'up-to-date') upToDate++;
				else if (m.value) rows.push(m.value);
			}
		});
		return { gate, controller, rows, upToDate: () => upToDate };
	};

	beforeEach(() => {
		mode = 'trust';
		trusted = false;
		installModalServer();
	});

	it('G1 trust → open: "Check again" resumes the parked stream without a read-session token', async () => {
		const s = await startUserCardsStream();
		try {
			// Untrusted in trust mode: 401 → /read_session 403 → parked, banner on.
			await waitFor(() => s.gate.isShapeBlocked('user_card'));
			await new Promise((r) => setTimeout(r, 50));
			expect(s.gate.hasBlockedShapes()).toBe(true);
			expect(shapeReqs().map((r) => r.authorization ?? '')).toEqual(['']);
			expect(opens()).toHaveLength(1);

			mode = 'open'; // owner switches the device; /read_session still says 403

			s.gate.probeAllBlocked(); // what the banner's "Check again" calls
			await waitFor(() => s.upToDate() > 0).catch(() => {});

			expect(s.upToDate()).toBeGreaterThan(0);
			expect(s.rows).toEqual([{ user_hash: 'u1' }]);
			expect(s.gate.hasBlockedShapes()).toBe(false);
			expect(shapeReqs().every((r) => !r.authorization)).toBe(true);
			expect(opens().every((o) => o.shape === 'user_card')).toBe(true);
		} finally {
			s.controller.abort();
			s.gate.resetGate();
		}
	});

	it('G2 trusted later: "Check again" opens a session and the stream resumes with the token', async () => {
		const s = await startUserCardsStream();
		try {
			await waitFor(() => s.gate.isShapeBlocked('user_card'));
			trusted = true; // owner vouches; mode stays trust

			s.gate.probeAllBlocked();
			await waitFor(() => s.upToDate() > 0);

			expect(s.gate.hasBlockedShapes()).toBe(false);
			expect(s.rows).toEqual([{ user_hash: 'u1' }]);
			expect(shapeReqs().at(-1)?.authorization).toMatch(/^Bearer tok-user_card-\d+$/);
		} finally {
			s.controller.abort();
			s.gate.resetGate();
		}
	});

	it('G3 still untrusted in trust mode: repeated "Check again" stays blocked with bounded requests and no loop', async () => {
		const s = await startUserCardsStream();
		try {
			await waitFor(() => s.gate.isShapeBlocked('user_card'));
			await new Promise((r) => setTimeout(r, 50));
			for (let i = 0; i < 5; i++) s.gate.probeAllBlocked();
			await waitFor(() => shapeReqs().length === 2 && opens().length === 3, 5000);
			await new Promise((r) => setTimeout(r, 100));
			const afterBurst = requests.length;
			await new Promise((r) => setTimeout(r, 1500));

			expect(s.gate.hasBlockedShapes()).toBe(true);
			expect(s.upToDate()).toBe(0);
			expect(requests.length).toBe(afterBurst);
			expect(opens().length - 1).toBeLessThanOrEqual(2);
			expect(shapeReqs().length - 1).toBeLessThanOrEqual(1);
		} finally {
			s.controller.abort();
			s.gate.resetGate();
		}
	});
});
