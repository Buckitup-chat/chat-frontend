import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetGate } from '@/lib/data/accessGate';

const denyReadSession = { value: false };
vi.mock('@/lib/data/readSession', () => ({
	bearerFor: () => '',
	openSession: async () => null,
	handleShapeAuth401: async ({ shape }: { shape: string }) => {
		if (denyReadSession.value) (await import('@/lib/data/accessGate')).markShapeBlocked(shape);
		return false;
	},
}));

const { readPeerGallery, fetchGalleryRow, forgetPeerGalleryReads, _setPeerGallerySignPkeyResolverForTests } = await import('@/lib/avatars/peerGallery');
const { sealSharedGallery } = await import('@/lib/avatars/sharedGallery');
const { randomBytes } = await import('@noble/hashes/utils');
const { _setActiveSessionForTests } = await import('@/lib/data/outbox');
const { SessionFencedError } = await import('@/lib/data/sessionGuard');
const { toBase64Unpadded } = await import('@buckitup/pq-client/signature');
const { galleryAccount, signPkeyResolver, galleryRecord, signStorageRow } = await import('./helpers/sharedGalleryRows');

const OWNER = galleryAccount(1);
const STRANGER = galleryAccount(2);
const READER = 'u_' + 'a'.repeat(128);
const OTHER_READER = 'u_' + 'b'.repeat(128);
const UUID = '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b';
const NEW_UUID = '1c8f4b63-ad2e-4071-9b3c-4d5e6f7a8b9c';
const KEY = randomBytes(32);
const grant = { ownerHash: OWNER.userHash, galleryUuid: UUID, galleryKeyB64: toBase64Unpadded(KEY) };
const id = (c: string) => c.repeat(32);

type Row = Record<string, unknown>;
let table: Row[];
let requests: string[];
let respond: null | (() => Response | Promise<Response>);

const electricBody = (rows: Row[]) => JSON.stringify([
	...rows.map((value) => ({ headers: { operation: 'insert' }, key: `"public"."user_storage"/"${value.user_hash}"/"${value.uuid}"`, value })),
	{ headers: { control: 'up-to-date' } },
]);

const fakeFetch = async (input: string | URL): Promise<Response> => {
	const url = new URL(String(input));
	const where = url.searchParams.get('where') ?? '';
	requests.push(where);
	if (respond) return respond();
	const wanted = Object.fromEntries([...where.matchAll(/(\w+)='([^']*)'/g)].map((m) => [m[1], m[2]]));
	const rows = table.filter((r) => Object.entries(wanted).every(([k, v]) => r[k] === v));
	return new Response(electricBody(rows), { status: 200 });
};

const galleryRow = async (ts: number, record = galleryRecord([id('a'), 1, 100]), { uuid = UUID, key = KEY } = {}) =>
	signStorageRow(OWNER, { uuid, owner_timestamp: ts, value_b64: await sealSharedGallery({ ownerHash: OWNER.userHash, galleryUuid: uuid }, key, record) });

const deferred = () => {
	let resolve!: (rows: Row[]) => void;
	const released = new Promise<Row[]>((r) => { resolve = r; });
	return { answer: async () => new Response(electricBody(await released), { status: 200 }), resolve };
};

beforeEach(() => {
	table = [];
	requests = [];
	respond = null;
	denyReadSession.value = false;
	vi.stubGlobal('fetch', fakeFetch);
	_setPeerGallerySignPkeyResolverForTests(signPkeyResolver(OWNER, STRANGER));
	_setActiveSessionForTests(READER);
	forgetPeerGalleryReads();
});
afterEach(() => {
	vi.unstubAllGlobals();
	resetGate();
	_setPeerGallerySignPkeyResolverForTests(null);
});

describe('reading the row at exactly (owner, uuid)', () => {
	it('asks for both halves of the key and reads the verified gallery', async () => {
		table = [await galleryRow(10)];
		const state = await readPeerGallery(READER, grant);
		expect(state).toMatchObject({ state: 'gallery' });
		expect(state.state === 'gallery' && state.entries.map((e) => e.avatarId)).toEqual([id('a')]);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(`user_hash='${OWNER.userHash}' AND uuid='${UUID}'`);
	});

	it('refuses an address that would not be a literal in the where clause', async () => {
		await expect(fetchGalleryRow({ ownerHash: `${OWNER.userHash}' OR '1'='1`, galleryUuid: UUID })).rejects.toThrow(TypeError);
		await expect(fetchGalleryRow({ ownerHash: OWNER.userHash, galleryUuid: `${UUID}'--` })).rejects.toThrow(TypeError);
		expect(requests).toEqual([]);
	});

	it('refuses a row whose signature does not hold, and keeps nothing of it', async () => {
		const row = await galleryRow(10);
		table = [{ ...row, value_b64: (await galleryRow(10, galleryRecord([id('b'), 2, 200]))).value_b64 }];
		expect(await readPeerGallery(READER, grant)).toMatchObject({ state: 'invalid_signature' });
		table = [row];
		expect(await readPeerGallery(READER, grant)).toMatchObject({ state: 'gallery' });
		expect(requests).toHaveLength(2);
	});
});

describe('no row, a blocked read and a failed read stay apart', () => {
	it('a server error or a network failure is a failed read, not a missing row', async () => {
		respond = () => new Response('', { status: 503 });
		expect(await readPeerGallery(READER, grant)).toEqual({ state: 'unavailable', reason: 'read_failed' });
		respond = () => Promise.reject(new TypeError('network down'));
		expect(await readPeerGallery(READER, grant)).toEqual({ state: 'unavailable', reason: 'read_failed' });
	});
});

describe('sharing reads', () => {
	it('concurrent callers share one read; a call after it has finished reads again', async () => {
		table = [await galleryRow(10)];
		const gate = deferred();
		respond = gate.answer;
		const a = readPeerGallery(READER, grant);
		const b = readPeerGallery(READER, grant);
		gate.resolve(table);
		const [sa, sb] = await Promise.all([a, b]);
		expect(sa).toBe(sb);
		expect(sa.state).toBe('gallery');
		expect(requests).toHaveLength(1);
		respond = null;
		await readPeerGallery(READER, grant);
		expect(requests).toHaveLength(2);
	});

	it('a fresh read waits out the one in flight and reads again, while a plain caller still joins it', async () => {
		const before = [await galleryRow(10)];
		const gate = deferred();
		let served = 0;
		respond = () => (served++ === 0 ? gate.answer() : new Response(electricBody(table), { status: 200 }));
		const first = readPeerGallery(READER, grant);
		const joined = readPeerGallery(READER, grant);
		const fresh = readPeerGallery(READER, grant, { fresh: true });
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		table = [await galleryRow(20, galleryRecord([id('b'), 2, 200]))];
		gate.resolve(before);
		expect(await joined).toBe(await first);
		const after = await fresh;
		expect(after.state === 'gallery' && after.entries[0].avatarId).toBe(id('b'));
		expect(requests).toHaveLength(2);
	});
});

describe('fencing to the signed-in account', () => {
	it('a read that lands after an account switch is thrown away', async () => {
		table = [await galleryRow(10)];
		const gate = deferred();
		respond = gate.answer;
		const pending = readPeerGallery(READER, grant);
		_setActiveSessionForTests(OTHER_READER);
		gate.resolve(table);
		await expect(pending).rejects.toThrow(SessionFencedError);
		respond = null;
		await readPeerGallery(OTHER_READER, grant);
		expect(requests).toHaveLength(2);
	});
});

describe('grant replacement', () => {
	const holdRequests = () => {
		const held: Array<ReturnType<typeof deferred>> = [];
		respond = () => {
			const gate = deferred();
			held.push(gate);
			return gate.answer();
		};
		return held;
	};
	const newKey = randomBytes(32);
	const replaced = { ...grant, galleryUuid: NEW_UUID, galleryKeyB64: toBase64Unpadded(newKey) };
	const bothRows = async () => [await galleryRow(10), await galleryRow(5, galleryRecord([id('c'), 3, 300]), { uuid: NEW_UUID, key: newKey })];

	it('an old grant\'s read resolving after the new grant\'s is superseded: nothing to show', async () => {
		table = await bothRows();
		const held = holdRequests();
		const old = readPeerGallery(READER, grant);
		const fresh = readPeerGallery(READER, replaced);
		held[1].resolve(table.filter((r) => r.uuid === NEW_UUID));
		expect(await fresh).toMatchObject({ state: 'gallery', entries: [{ avatarId: id('c') }] });
		held[0].resolve(table.filter((r) => r.uuid === UUID));
		expect(await old).toEqual({ state: 'superseded' });
	});

	it('a fresh read waiting on the old grant\'s read is superseded by a new grant, and never reads the old grant again', async () => {
		table = await bothRows();
		const held = holdRequests();
		const old = readPeerGallery(READER, grant);
		const fresh = readPeerGallery(READER, grant, { fresh: true });
		await vi.waitFor(() => expect(held).toHaveLength(1));
		const next = readPeerGallery(READER, replaced);
		await vi.waitFor(() => expect(held).toHaveLength(2));
		held[0].resolve(table.filter((r) => r.uuid === UUID));
		expect(await old).toEqual({ state: 'superseded' });
		expect(await fresh).toEqual({ state: 'superseded' });
		held[1].resolve(table.filter((r) => r.uuid === NEW_UUID));
		expect(await next).toMatchObject({ state: 'gallery', entries: [{ avatarId: id('c') }] });
		expect(requests.filter((w) => w.includes(`uuid='${UUID}'`))).toHaveLength(1);
		respond = null;
		expect(await readPeerGallery(READER, replaced)).toMatchObject({ state: 'gallery' });
		expect(requests.at(-1)).toContain(`uuid='${NEW_UUID}'`);
	});
});

