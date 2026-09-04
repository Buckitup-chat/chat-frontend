import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FakeItem = { id: string };

function fakeSyncedOptions(id: string) {
	return {
		id,
		getKey: (item: FakeItem) => item.id,
		sync: { sync: () => {} },
	};
}

describe('electricPersistence', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.doUnmock('@tanstack/browser-db-sqlite-persistence');
		vi.restoreAllMocks();
	});

	it('falls back to non-persisted mode and warns visibly when OPFS/Worker are unavailable', async () => {
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('Worker', undefined);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const mod = await import('@/utils/db/tanstack/electricPersistence');
		await mod.electricPersistenceReady;

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPFS/Worker not available'));

		const options = fakeSyncedOptions('dialog_messages');
		expect(mod.withElectricPersistence(options)).toBe(options);
	});

	it('falls back to non-persisted mode and warns visibly when opening the OPFS database throws', async () => {
		vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue({}) } });
		vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
		vi.doMock('@tanstack/browser-db-sqlite-persistence', () => ({
			openBrowserWASQLiteOPFSDatabase: vi.fn().mockRejectedValue(new Error('opfs boom')),
			createBrowserWASQLitePersistence: vi.fn(),
		}));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const mod = await import('@/utils/db/tanstack/electricPersistence');
		await mod.electricPersistenceReady;

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to initialize SQLite/OPFS persistence'), expect.any(Error));

		const options = fakeSyncedOptions('dialog_messages');
		expect(mod.withElectricPersistence(options)).toBe(options);
	});

	it('wraps synced collection options with SQLite persistence when OPFS/Worker are available', async () => {
		vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue({}) } });
		vi.stubGlobal('Worker', class {} as unknown as typeof Worker);
		const fakeAdapter = {
			loadSubset: vi.fn().mockResolvedValue([]),
			applyCommittedTx: vi.fn().mockResolvedValue(undefined),
			ensureIndex: vi.fn().mockResolvedValue(undefined),
		};
		vi.doMock('@tanstack/browser-db-sqlite-persistence', () => ({
			openBrowserWASQLiteOPFSDatabase: vi.fn().mockResolvedValue({}),
			createBrowserWASQLitePersistence: vi.fn().mockReturnValue({ adapter: fakeAdapter }),
		}));

		const mod = await import('@/utils/db/tanstack/electricPersistence');
		await mod.electricPersistenceReady;

		const options = fakeSyncedOptions('dialog_messages');
		const wrapped = mod.withElectricPersistence(options, 2);

		expect(wrapped).not.toBe(options);
		expect(wrapped.id).toBe('dialog_messages');
	});
});
