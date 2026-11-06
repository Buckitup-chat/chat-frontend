// A browser for the storage status store (`_useStorageEnvForTests`), as the
// screens that show the status see it: a normal window with 10 GB of quota,
// best-effort unless told otherwise.
import type { StorageEnv } from '@/lib/storageStatus';

export type FakeStorageOptions = {
	persisted?: boolean;
	quota?: number;
	noStorage?: boolean;
	/** persist() grants persistence. */
	grants?: boolean;
	installed?: boolean;
	/** What a localStorage write throws. */
	localStorage?: Error;
};

export const fakeStorageEnv = (o: FakeStorageOptions = {}): StorageEnv => {
	let persisted = o.persisted ?? false;
	return {
		storage: o.noStorage
			? undefined
			: {
					persisted: async () => persisted,
					persist: async () => (o.grants ? (persisted = true) : persisted),
					estimate: async () => ({ usage: 1024, quota: o.quota ?? 10 * 1024 ** 3 }),
				},
		matchMedia: () => ({ matches: o.installed === true }),
		localStorage: () => ({
			setItem: () => {
				if (o.localStorage) throw o.localStorage;
			},
			removeItem: () => {},
		}),
		userAgent: 'TestBrowser/1.0',
		platform: 'TestOS',
	};
};
