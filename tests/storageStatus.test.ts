// The storage status (src/lib/storageStatus.ts): what a browser says about
// clearing this origin's data, read through a fake navigator.storage and
// matchMedia so every branch is reached without a real browser.
import { describe, it, expect, vi } from 'vitest';
import { probeStorage, requestPersistence, isInstalled, formatBytes, SMALL_QUOTA_BYTES, type StorageEnv } from '@/lib/storageStatus';
import { probeRows, probeText } from '@/composables/useStorageStatus';

vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => ({}) } }));
vi.mock('@/store/recoveryBackup.store', () => ({ BACKUP_SLOT: 'recovery_backup' }));

const GB = 1024 ** 3;

interface FakeOptions {
	persisted?: boolean | (() => Promise<boolean>);
	persistGrants?: boolean;
	quota?: number;
	usage?: number;
	opfs?: 'ok' | Error | 'missing';
	localStorage?: 'ok' | Error;
	standalone?: { media?: boolean; ios?: boolean };
	noStorage?: boolean;
}

const fakeEnv = (o: FakeOptions = {}): StorageEnv & { persistCalls: () => number } => {
	let persisted = typeof o.persisted === 'boolean' ? o.persisted : false;
	let persistCalls = 0;
	const storage: StorageEnv['storage'] = {
		persisted: typeof o.persisted === 'function' ? o.persisted : async () => persisted,
		persist: async () => {
			persistCalls += 1;
			if (o.persistGrants) persisted = true;
			return persisted;
		},
		estimate: async () => ({ usage: o.usage ?? 5 * 1024 * 1024, quota: o.quota ?? 50 * GB }),
	};
	if (o.opfs !== 'missing') {
		storage.getDirectory = async () => {
			if (o.opfs instanceof Error) throw o.opfs;
			return {} as FileSystemDirectoryHandle;
		};
	}
	return {
		storage: o.noStorage ? undefined : storage,
		matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && o.standalone?.media === true }),
		standalone: o.standalone?.ios,
		localStorage: () => ({
			setItem: () => {
				if (o.localStorage instanceof Error) throw o.localStorage;
			},
			removeItem: () => {},
		}),
		userAgent: 'TestBrowser/1.0',
		platform: 'TestOS',
		persistCalls: () => persistCalls,
	};
};

const securityError = () => Object.assign(new Error('Security error when calling GetDirectory'), { name: 'SecurityError' });

describe('the storage status', () => {
	it('is persistent when persisted() is true', async () => {
		const p = await probeStorage(fakeEnv({ persisted: true }));
		expect(p.status).toBe('persistent');
		expect(p.persisted).toBe(true);
		expect(p.privateSignals).toEqual([]);
	});

	it('is best-effort when persisted() is false and nothing looks private', async () => {
		const p = await probeStorage(fakeEnv({ persisted: false }));
		expect(p.status).toBe('best-effort');
		expect(p.persisted).toBe(false);
		expect(p.usage).toBe(5 * 1024 * 1024);
		expect(p.quota).toBe(50 * GB);
	});

	it('is ephemeral when the quota is very small', async () => {
		const p = await probeStorage(fakeEnv({ quota: SMALL_QUOTA_BYTES - 1 }));
		expect(p.status).toBe('ephemeral');
		expect(p.privateSignals).toEqual([expect.stringContaining('quota')]);
	});

	it('takes a quota at the threshold for a normal one', async () => {
		expect((await probeStorage(fakeEnv({ quota: SMALL_QUOTA_BYTES }))).status).toBe('best-effort');
	});

	it('is ephemeral when the file system refuses to open, as in a Firefox private window', async () => {
		const p = await probeStorage(fakeEnv({ opfs: securityError() }));
		expect(p.status).toBe('ephemeral');
		expect(p.privateSignals).toEqual([expect.stringContaining('SecurityError')]);
	});

	it('is ephemeral when localStorage refuses a write', async () => {
		const p = await probeStorage(fakeEnv({ localStorage: Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) }));
		expect(p.status).toBe('ephemeral');
		expect(p.privateSignals).toEqual([expect.stringContaining('localStorage refused')]);
	});

	it('does not take a missing file system for a refusing one', async () => {
		expect((await probeStorage(fakeEnv({ opfs: 'missing' }))).status).toBe('best-effort');
	});

	it('keeps persistent over private-window signals: a browser does not grant persistence to a private window', async () => {
		const p = await probeStorage(fakeEnv({ persisted: true, quota: 10 * 1024 * 1024 }));
		expect(p.status).toBe('persistent');
		expect(p.privateSignals).toHaveLength(1);
	});

	it('is unknown when the Storage API is missing', async () => {
		const p = await probeStorage(fakeEnv({ noStorage: true }));
		expect(p).toMatchObject({ status: 'unknown', persisted: null, usage: null, quota: null });
	});

	it('is unknown when persisted() fails', async () => {
		const p = await probeStorage(fakeEnv({ persisted: () => Promise.reject(new Error('no')) }));
		expect(p.status).toBe('unknown');
		expect(p.persisted).toBeNull();
	});
});

describe('installed', () => {
	it('reads display-mode standalone and iOS navigator.standalone', () => {
		expect(isInstalled(fakeEnv())).toBe(false);
		expect(isInstalled(fakeEnv({ standalone: { media: true } }))).toBe(true);
		expect(isInstalled(fakeEnv({ standalone: { ios: true } }))).toBe(true);
	});

	it('is part of the probe', async () => {
		expect((await probeStorage(fakeEnv({ standalone: { media: true } }))).installed).toBe(true);
	});
});

describe('requesting persistence', () => {
	it('reports persisted() before and after persist()', async () => {
		const env = fakeEnv({ persisted: false, persistGrants: true });
		expect(await requestPersistence(env)).toEqual({ before: false, granted: true, after: true });
		expect(env.persistCalls()).toBe(1);
	});

	it('reports a refusal as such', async () => {
		expect(await requestPersistence(fakeEnv({ persisted: false }))).toEqual({ before: false, granted: false, after: false });
	});

	it('says when persist() is missing', async () => {
		const r = await requestPersistence(fakeEnv({ noStorage: true }));
		expect(r).toMatchObject({ before: null, granted: null, after: null });
		expect(r.error).toContain('missing');
	});

	it('the probe never asks for persistence', async () => {
		const env = fakeEnv();
		await probeStorage(env);
		expect(env.persistCalls()).toBe(0);
	});
});

describe('the probe table', () => {
	it('holds every probed value and the request, and copies as one line per row', async () => {
		const p = await probeStorage(fakeEnv({ quota: 2 * GB, usage: 1536 }));
		const rows = probeRows(p, { before: false, granted: true, after: true }, 'not found');
		expect(Object.fromEntries(rows)).toMatchObject({
			Status: 'best-effort',
			'persisted()': 'no',
			Usage: '1.5 KB',
			Quota: '2.0 GB',
			'Installed (standalone)': 'no',
			'Private window': 'not detected',
			'Community backup': 'not found',
			'persisted() before persist()': 'no',
			'persist() answered': 'yes',
			'persisted() after persist()': 'yes',
			Platform: 'TestOS',
			'User agent': 'TestBrowser/1.0',
		});
		expect(probeText(rows).split('\n')).toContain('Quota: 2.0 GB');
	});

	it('formats sizes for people', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(SMALL_QUOTA_BYTES)).toBe('120 MB');
		expect(formatBytes(64 * GB)).toBe('64 GB');
		expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
		expect(formatBytes(1023)).toBe('1023 B');
	});
});
