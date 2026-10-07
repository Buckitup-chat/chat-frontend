import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@electric-sql/client';

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

interface Recorded {
	url: string;
	authorization: string | null;
}

let requests: Recorded[];

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const installServer = (table: string, shape: string) => {
	requests = [];
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		requests.push({ url, authorization: headers.get('authorization') });
		if (url.includes('/challenge')) {
			return json(200, { challenge_id: 'cid-1', challenge: 'ab'.repeat(32), expires_in: 60 });
		}
		if (url.includes('/read_session')) {
			const body = JSON.parse(String(init?.body));
			expect(body.shape).toBe(shape);
			return json(200, { token: `tok-${shape}`, shape, expires_in: 300 });
		}
		if (url.includes(`/shapes?table=${table}`)) {
			if (headers.get('authorization') === `Bearer tok-${shape}`) return json(200, []);
			return json(401, { error: 'read_session_required', shape });
		}
		throw new Error(`unexpected fetch ${url}`);
	});
};

const shapeReads = (table: string) => requests.filter((r) => r.url.includes(`/shapes?table=${table}`));

beforeEach(async () => {
	captured.length = 0;
	vi.resetModules();
});

describe('read session token is used for the table that was gated', () => {
	it('readShapeOnce(user_cards) retries with the token opened for shape user_card', async () => {
		installServer('user_cards', 'user_card');
		const { readShapeOnce } = await import('@/lib/data/shapeRead');

		const outcome = await readShapeOnce('user_cards', "user_hash = 'x'").then(
			(rows) => ({ ok: true as const, rows }),
			(error: Error) => ({ ok: false as const, error: error.message }),
		);

		const reads = shapeReads('user_cards');
		const opened = requests.filter((r) => r.url.includes('/read_session'));

		expect(opened).toHaveLength(1);
		expect(reads).toHaveLength(2);
		expect(reads[0].authorization).toBeNull();
		expect(reads[1].authorization).toBe('Bearer tok-user_card');
		expect(outcome).toEqual({ ok: true, rows: [] });
	});

	it('user_cards collection header resolves the user_card token after onError opens it', async () => {
		installServer('user_cards', 'user_card');
		const { getUserCardsCollection } = await import('@/lib/data/collections');
		getUserCardsCollection();
		const opts = captured.find((o) => o.shapeOptions?.params?.table === 'user_cards');
		expect(opts).toBeTruthy();

		const res = await fetch('/api/shapes?table=user_cards&offset=-1');
		const error = await FetchError.fromResponse(res, '/api/shapes?table=user_cards&offset=-1');
		expect(error.status).toBe(401);

		const retry = await opts.shapeOptions.onError(error);
		const header = opts.shapeOptions.headers.Authorization();

		expect(requests.filter((r) => r.url.includes('/read_session'))).toHaveLength(1);
		expect(retry).toEqual({});
		expect(header).toBe('Bearer tok-user_card');
	});

	it('dialog_messages_versions collection header resolves the dialog_messages token after onError opens it', async () => {
		installServer('dialog_messages_versions', 'dialog_messages');
		const { getDialogCollections } = await import('@/lib/data/collections');
		getDialogCollections(DIALOG);
		const opts = captured.find((o) => o.shapeOptions?.params?.table === 'dialog_messages_versions');
		expect(opts).toBeTruthy();

		const url = '/api/shapes?table=dialog_messages_versions&offset=-1';
		const error = await FetchError.fromResponse(await fetch(url), url);
		expect(error.status).toBe(401);

		const retry = await opts.shapeOptions.onError(error);
		const header = opts.shapeOptions.headers.Authorization();

		expect(requests.filter((r) => r.url.includes('/read_session'))).toHaveLength(1);
		expect(retry).toEqual({});
		expect(header).toBe('Bearer tok-dialog_messages');
	});

	it('readShapeOnce(dialog_messages_versions) retries with the token opened for shape dialog_messages', async () => {
		installServer('dialog_messages_versions', 'dialog_messages');
		const { readShapeOnce } = await import('@/lib/data/shapeRead');

		const outcome = await readShapeOnce('dialog_messages_versions', `dialog_hash = '${DIALOG}'`).then(
			(rows) => ({ ok: true as const, rows }),
			(error: Error) => ({ ok: false as const, error: error.message }),
		);

		const reads = shapeReads('dialog_messages_versions');

		expect(requests.filter((r) => r.url.includes('/read_session'))).toHaveLength(1);
		expect(reads).toHaveLength(2);
		expect(reads[0].authorization).toBeNull();
		expect(reads[1].authorization).toBe('Bearer tok-dialog_messages');
		expect(outcome).toEqual({ ok: true, rows: [] });
	});

	it('control: readShapeOnce(user_storage) works where table and shape names coincide', async () => {
		installServer('user_storage', 'user_storage');
		const { readShapeOnce } = await import('@/lib/data/shapeRead');

		await expect(readShapeOnce('user_storage', "uuid = 'x'")).resolves.toEqual([]);
		const reads = shapeReads('user_storage');
		expect(reads.map((r) => r.authorization)).toEqual([null, 'Bearer tok-user_storage']);
	});
});
