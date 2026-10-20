import { describe, it, expect, vi } from 'vitest';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import { toBase64Unpadded } from '@/lib/pq/signature';
import {
	obtainGalleryMapping, initialGalleryMapping, parseGalleryMapping, GalleryMappingError, SHARED_GALLERY_FIELD,
	type GalleryMapping, type MappingRootAccess, type RootWriteStatus,
} from '@/lib/avatars/galleryMapping';

type Root = Record<string, unknown>;

const makeAccount = (seed: number) => ({ cryptSkey: new Uint8Array(64).fill(seed), server: { root: null as Root | null } });
type Account = ReturnType<typeof makeAccount>;

const makeDevice = (account: Account) => {
	const { server } = account;
	const state = {
		network: 'online' as 'online' | 'offline' | 'unproven',
		liveReadable: true,
		holdLanding: null as null | Promise<void>,
		current: true,
		pending: null as Root | null,
		writes: [] as Root[],
	};
	const deliver = async (): Promise<RootWriteStatus> => {
		const signed = stripPatchDirectives(mergeJsonPatch(server.root, state.pending!));
		state.pending = null;
		if (state.holdLanding) await state.holdLanding;
		server.root = signed;
		return 'synced';
	};
	const access: MappingRootAccess = {
		readLive: async () => (state.liveReadable && server.root ? { state: 'found', record: server.root } : { state: 'unknown' }),
		writePatch: async (patch) => {
			state.writes.push(patch);
			state.pending = state.pending ? mergeJsonPatch(state.pending, patch) : patch;
			if (state.network === 'offline') return 'queued';
			if (state.network === 'unproven') return 'awaiting-recovery';
			return deliver();
		},
		assertCurrent: () => {
			if (!state.current) throw new SessionFencedError('[test] the account changed');
		},
	};
	const obtain = () => obtainGalleryMapping(access, initialGalleryMapping(account.cryptSkey));
	const reconnect = async () => {
		state.network = 'online';
		if (state.pending) await deliver();
	};
	return { state, access, obtain, reconnect };
};

const mappingOn = (account: Account) => parseGalleryMapping(account.server.root?.[SHARED_GALLERY_FIELD]);
const ready = (mapping: GalleryMapping | null) => ({ state: 'ready', mapping });
const other: GalleryMapping = {
	galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: toBase64Unpadded(new Uint8Array(32).fill(9)), generation: 2,
};

describe('the initial mapping', () => {
	it('is written into a root that has none, other fields kept, and returned once the server holds it', async () => {
		const account = makeAccount(1);
		account.server.root = { name: 'Alice', slots: { contacts: 'c' } };
		const initial = initialGalleryMapping(account.cryptSkey);
		expect(await makeDevice(account).obtain()).toEqual(ready(initial));
		expect(mappingOn(account)).toEqual(initial);
		expect(account.server.root).toMatchObject({ name: 'Alice', slots: { contacts: 'c' } });
	});
});

describe('a mapping the root already holds', () => {
	it('is adopted though it is not the derived one', async () => {
		const account = makeAccount(1);
		account.server.root = { [SHARED_GALLERY_FIELD]: other };
		const device = makeDevice(account);
		expect(await device.obtain()).toEqual(ready(other));
		expect(device.state.writes).toEqual([]);
	});
});

describe('simultaneous writers of one account', () => {
	it('two devices that both sign before either lands are both ready with the one mapping the server holds', async () => {
		for (const secondLandsLast of [true, false]) {
			const account = makeAccount(1);
			const [first, second] = [makeDevice(account), makeDevice(account)];
			let landFirst!: () => void;
			let landSecond!: () => void;
			first.state.holdLanding = new Promise((r) => { landFirst = r; });
			second.state.holdLanding = new Promise((r) => { landSecond = r; });
			const calls = [first.obtain(), second.obtain()];
			await vi.waitFor(() => expect([first.state.writes, second.state.writes].map((w) => w.length)).toEqual([1, 1]));
			if (secondLandsLast) { landFirst(); await Promise.resolve(); landSecond(); } else { landSecond(); await Promise.resolve(); landFirst(); }
			const [a, b] = await Promise.all(calls);
			const initial = initialGalleryMapping(account.cryptSkey);
			expect(a).toEqual(ready(initial));
			expect(b).toEqual(ready(initial));
			expect(mappingOn(account)).toEqual(initial);
		}
	});
});

describe('what is not known is not returned', () => {
	it('a malformed mapping in the root is refused, and nothing is written', async () => {
		const account = makeAccount(1);
		const malformed = { galleryUuid: 'nope', galleryKeyB64: 'x', generation: 0 };
		account.server.root = { [SHARED_GALLERY_FIELD]: malformed };
		const device = makeDevice(account);
		await expect(device.obtain()).rejects.toThrow(GalleryMappingError);
		expect(device.state.writes).toEqual([]);
	});
});

describe('account switching', () => {
	it('a switch while the write is out returns no mapping to the next account', async () => {
		const device = makeDevice(makeAccount(1));
		const write = device.access.writePatch;
		device.access.writePatch = async (patch) => { const s = await write(patch); device.state.current = false; return s; };
		await expect(device.obtain()).rejects.toThrow(SessionFencedError);
	});
});
