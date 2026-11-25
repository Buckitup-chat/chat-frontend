// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromBase64, toBase64Unpadded } from '@buckitup/pq-client/signature';
import { deriveRootSlotUuid } from '@buckitup/pq-client/slotId';
import * as harness from './helpers/twoClients';
import type { Client } from './helpers/twoClients';

const { server, net, register, startApp, stopAll, newClient } = harness;

vi.mock('@lo-fi/local-vault', async () => (await import('./helpers/twoClients')).vaultModule);
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('vue-router', async () => {
	const { route } = await import('./helpers/twoClients');
	return {
		useRoute: () => ({ params: { get address() { return route.peer; } }, query: {} }),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	};
});

const session = async (client: Client) => {
	const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
	const { GalleryMappingError, SHARED_GALLERY_FIELD } = await import('@/lib/avatars/galleryMapping');
	const { putStorageJsonPatch } = await import('@/lib/data/userStorage');
	const { getUserStorageCollection } = await import('@/lib/data/collections');
	const em = EncryptionManagerPQ.getInstance();
	const keys = await em.exportVaultKeys();
	const signSkey = fromBase64(keys.sign_skey);
	const rootUuid = deriveRootSlotUuid(fromBase64(keys.crypt_skey));
	return {
		em,
		GalleryMappingError,
		SHARED_GALLERY_FIELD,
		writeRoot: (jsonPatch: Record<string, unknown>) => putStorageJsonPatch({ userHash: client.hash, uuid: rootUuid, jsonPatch, signSkey }),
		storage: getUserStorageCollection(client.hash) as { preload(): Promise<void> },
		rootUuid,
		rootOnServer: () => server.table('user_storage').get(`${client.hash}|${rootUuid}`),
	};
};

const other = { galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: toBase64Unpadded(new Uint8Array(32).fill(9)), generation: 2 };

const newDeviceOf = async (first: Client) => {
	const device: Client = { ...newClient(`${first.name} on a new device`), vault: first.vault, hash: first.hash };
	await startApp(device);
	const { getUserStorageCollection } = await import('@/lib/data/collections');
	const { createShapeLink, registerShapeLink } = await import('@/lib/data/shapeLink');
	type Stream = { get(key: string): unknown; utils: { awaitMatch(fn: (m: unknown) => boolean, t?: number): Promise<boolean> } };
	const coll = getUserStorageCollection(device.hash) as unknown as Stream;
	const stream = { up: true, holdsRows: true, waiting: [] as (() => void)[] };
	const get = coll.get.bind(coll);
	coll.get = (key) => (stream.holdsRows ? get(key) : undefined);
	const awaitMatch = coll.utils.awaitMatch.bind(coll.utils);
	coll.utils.awaitMatch = (fn, t) => (stream.up ? awaitMatch(fn, t) : new Promise((resolve) => { stream.waiting.push(() => resolve(awaitMatch(fn, t))); }));
	const link = createShapeLink();
	registerShapeLink(coll, link);
	return {
		device,
		signIn: () => device.app.store.login(device.hash),
		failStream: ({ holdsRows }: { holdsRows: boolean }) => {
			stream.up = false;
			stream.holdsRows = holdsRows;
			link.report();
		},
		recoverStream: () => {
			stream.up = true;
			stream.holdsRows = true;
			for (const resume of stream.waiting.splice(0)) resume();
		},
	};
};

const rootWritesSince = (from: number, rootUuid: string) => server.posts.slice(from)
	.filter((p) => p.relation === 'user_storage' && (p.row as { uuid: string }).uuid === rootUuid);

const withoutWaitingForPreload = async <T>(operation: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Known-root reading waited for the unresolved preload')), 1000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

let A: Client;
beforeEach(() => {
	server.reset();
	net.mode = 'online';
	A = newClient('Alice');
});
afterEach(() => stopAll());

describe('a malformed shared gallery mapping in the account record', () => {
	it('is refused, and never replaced while the live record cannot be read', async () => {
		await register(A);
		const s = await session(A);
		const malformed = { galleryUuid: 'nope', galleryKeyB64: 'x', generation: 0 };
		await s.writeRoot({ [s.SHARED_GALLERY_FIELD]: malformed });
		const before = s.rootOnServer();

		await expect(s.em.obtainSharedGalleryMapping()).rejects.toThrow(s.GalleryMappingError);
		expect(s.rootOnServer()).toBe(before);

		s.storage.preload = () => Promise.reject(new Error('[test] the shape stream failed'));
		await expect(s.em.obtainSharedGalleryMapping()).rejects.toThrow(s.GalleryMappingError);
		expect(s.rootOnServer()).toBe(before);
	});
});

describe('a mapping another device of the account wrote', () => {
	it.each([true, false])('preload never settles: held rows = %s, known-root reads finish without writing', async (holdsRows) => {
		await register(A);
		const first = await session(A);
		await first.writeRoot({ [first.SHARED_GALLERY_FIELD]: other });
		const before = first.rootOnServer();
		const postsBefore = server.posts.length;

		const fresh = await newDeviceOf(A);
		await fresh.signIn();
		const s = await session(fresh.device);
		const { kvGet } = await import('@/lib/data/localStore');
		const { getKnownStorageRow } = await import('@/lib/data/userStorage');
		const { verifyReplicatedRow } = await import('@/lib/data/rowVerification');
		const { getVerifiedSignPkey } = await import('@/lib/data/cardRegistry');
		expect(await kvGet(`us|${fresh.device.hash}|${s.rootUuid}`)).toBeUndefined();

		fresh.failStream({ holdsRows });
		const preload = vi.spyOn(s.storage, 'preload').mockReturnValue(new Promise<void>(() => {}));
		let preloadSettled = false;
		void s.storage.preload().then(() => { preloadSettled = true; });
		try {
			const row = await withoutWaitingForPreload(getKnownStorageRow(fresh.device.hash, s.rootUuid));
			if (holdsRows) {
				expect(row).toEqual(before);
				expect(await verifyReplicatedRow('user_storage', row!, getVerifiedSignPkey)).toEqual({ status: 'verified' });
			} else expect(row).toBeNull();
			expect(await withoutWaitingForPreload(s.em.obtainSharedGalleryMapping())).toEqual(holdsRows
				? { state: 'ready', mapping: other }
				: { state: 'pending', reason: 'unreadable' });
			expect(preloadSettled).toBe(false);
			expect(s.rootOnServer()).toBe(before);
			expect(rootWritesSince(postsBefore, s.rootUuid)).toEqual([]);
			const queued = await fresh.device.app.outbox.pendingEntries(fresh.device.hash);
			expect(JSON.stringify(queued)).not.toContain(s.rootUuid);
		} finally {
			preload.mockRestore();
		}
	});

	it('a new device that has not seen it neither replaces nor returns it while the live record cannot be read, and adopts it once the read recovers', async () => {
		await register(A);
		const first = await session(A);
		await first.writeRoot({ [first.SHARED_GALLERY_FIELD]: other });
		const before = first.rootOnServer();
		const postsBefore = server.posts.length;

		const fresh = await newDeviceOf(A);
		fresh.failStream({ holdsRows: false });
		await fresh.signIn();
		const s = await session(fresh.device);
		expect(await s.em.obtainSharedGalleryMapping()).toEqual({ state: 'pending', reason: 'unreadable' });
		const recovered = s.em.whenAccountRecordRecovers();
		expect(recovered).not.toBeNull();
		const queued = await fresh.device.app.outbox.pendingEntries(fresh.device.hash);
		expect(JSON.stringify(queued)).not.toContain(s.rootUuid);

		fresh.recoverStream();
		await recovered;
		expect(s.em.whenAccountRecordRecovers()).toBeNull();
		expect(await s.em.obtainSharedGalleryMapping()).toEqual({ state: 'ready', mapping: other });
		expect(s.rootOnServer()).toBe(before);
		expect(rootWritesSince(postsBefore, s.rootUuid)).toEqual([]);
	});

	it.each([
		['a valid mapping is adopted', other],
		['a malformed mapping is refused', { galleryUuid: 'nope', galleryKeyB64: 'x', generation: 0 }],
	])('received only through the shape and held after the stream fails: %s, never replaced', async (_name, mapping) => {
		await register(A);
		const first = await session(A);
		await first.writeRoot({ [first.SHARED_GALLERY_FIELD]: mapping });
		const before = first.rootOnServer();
		const postsBefore = server.posts.length;

		const fresh = await newDeviceOf(A);
		await fresh.signIn();
		const s = await session(fresh.device);
		expect(rootWritesSince(postsBefore, s.rootUuid)).toEqual([]);

		fresh.failStream({ holdsRows: true });
		const obtained = s.em.obtainSharedGalleryMapping();
		if (mapping === other) expect(await obtained).toEqual({ state: 'ready', mapping: other });
		else await expect(obtained).rejects.toThrow(s.GalleryMappingError);

		expect(s.rootOnServer()).toBe(before);
		expect(rootWritesSince(postsBefore, s.rootUuid)).toEqual([]);
	});
});
