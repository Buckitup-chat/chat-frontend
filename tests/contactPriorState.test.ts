import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = { valueB64: string; deletedFlag: boolean };
const h = vi.hoisted(() => ({
	rows: new Map<string, { valueB64: string; deletedFlag: boolean }>(),
	vaults: new Map<string, unknown>(),
	raw: new Map<string, unknown>(),
	mapped: null as string | null,
	winner: null as string | null,
	writeStatus: 'synced' as 'synced' | 'queued' | 'awaiting-recovery',
}));

const makeVault = (id: string) => {
	const data = new Map();
	return { id, async set(k: string, v: unknown) { data.set(k, v); }, async get(k: string) { return data.get(k); } };
};

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }: { vaultID?: string; addNewVault?: boolean }) => {
		if (addNewVault) {
			const id = `vault-${h.vaults.size + 1}`;
			h.vaults.set(id, makeVault(id));
			h.raw.set(`local-vault-${id}`, { accountID: `account-${id}`, data: 'sealed' });
			return h.vaults.get(id);
		}
		return h.vaults.get(vaultID!);
	},
	rawStorage: () => ({
		async get(k: string) { return h.raw.get(k); },
		async set(k: string, v: unknown) { h.raw.set(k, v); },
		async remove(k: string) { h.raw.delete(k); },
	}),
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({ async preload() {}, get: () => undefined, get toArray() { return []; } }),
}));
vi.mock('@/lib/data/ingest', () => ({
	DurabilityError: class DurabilityError extends Error {},
	sendMutationsAndAwaitShape: async () => ({ outboxId: 'test-outbox-id', phase: 'accepted', result: { ok: true }, acceptance: Promise.resolve({ kind: 'accepted' }) }),
	drainPendingWrites: async () => {},
	stopDrainLoop: () => {},
}));
vi.mock('@/lib/data/userStorage', () => {
	const merged = async (uuid: string, jsonPatch: unknown) => {
		const { _getStorageJsonCodecForTests, mergeJsonPatch, stripPatchDirectives } = await import('@/lib/data/storageIntent');
		const codec = _getStorageJsonCodecForTests()!;
		const stored = h.rows.get(uuid)?.valueB64;
		const base = stored ? await codec.decrypt(stored).catch(() => null) : null;
		const { valueB64 } = await codec.encrypt(stripPatchDirectives(mergeJsonPatch(base, jsonPatch as never)));
		return valueB64;
	};
	return {
		getStorageRow: async (_userHash: string, uuid: string) => {
			const row: Row | undefined = h.rows.get(uuid);
			return row ? { uuid, value_b64: row.valueB64, deleted_flag: row.deletedFlag } : null;
		},
		putStorageRow: async ({ uuid, valueB64, deletedFlag }: { uuid: string; valueB64: string; deletedFlag?: boolean }) => {
			h.rows.set(uuid, { valueB64, deletedFlag: !!deletedFlag });
			return { sync: Promise.resolve({ status: 'synced' }) };
		},
		putStorageJsonPatch: async ({ uuid, jsonPatch }: { uuid: string; jsonPatch: unknown }) => {
			const valueB64 = await merged(uuid, jsonPatch);
			h.rows.set(uuid, { valueB64, deletedFlag: false });
			return { uuid, value_b64: valueB64 };
		},
		saveStorageJsonPatch: async ({ uuid, jsonPatch, deletedFlag }: { uuid: string; jsonPatch: unknown; deletedFlag?: boolean }) => {
			if (h.writeStatus === 'awaiting-recovery') return 'awaiting-recovery';
			h.rows.set(uuid, { valueB64: await merged(uuid, jsonPatch), deletedFlag: !!deletedFlag });
			return h.writeStatus;
		},
	};
});
vi.mock('@buckitup/pq-client/slots', () => ({
	createSlotResolver: () => ({
		getSlotUuid: async (name: string) => (name === 'contacts' ? h.mapped : null),
		requireSlotUuid: async (name: string) => {
			if (name === 'contacts' && h.mapped) return h.mapped;
			throw new Error(`user_storage slot "${name}" is missing from the root record`);
		},
		ensureSlotUuid: async (_name: string, { mint, writeRow }: { mint: () => string; writeRow: (uuid: string) => Promise<void> }) => {
			if (h.mapped) {
				await writeRow(h.mapped);
				return { uuid: h.mapped, created: false };
			}
			const mine = mint();
			await writeRow(mine);
			if (h.winner) {
				h.mapped = h.winner;
				return { uuid: h.winner, created: false, orphaned: mine };
			}
			h.mapped = mine;
			return { uuid: mine, created: true };
		},
		reset: () => {},
	}),
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
const { _setIntentStorageForTests } = await import('@/lib/data/intents');
const { _setStorageForTests: setOutboxStorage } = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _getStorageJsonCodecForTests } = await import('@/lib/data/storageIntent');

const memoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const ANN = { user_hash: 'ann', contact_pkey: 'pkA', confirmed: true };
const newManager = async () => {
	const em = new EncryptionManagerPQ();
	await em.createUserVault({ name: 'Tester', notes: '', lock: 'legacy' });
	return em;
};

beforeEach(() => {
	_setIntentStorageForTests(memoryStore());
	setOutboxStorage(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
	h.rows = new Map();
	h.vaults = new Map();
	h.raw = new Map();
	h.mapped = null;
	h.winner = null;
	h.writeStatus = 'synced';
});

describe('what a contacts write reports about the list it was made on', () => {
	it('a slot this write creates is a known, empty prior list', async () => {
		const em = await newManager();
		const result = await em.saveContacts({ ann: ANN });
		expect(result.prior).toEqual({ state: 'new' });
		expect(result.status).toBe('synced');
	});

	it('a readable base is reported as it was, even when the write itself is only queued', async () => {
		const em = await newManager();
		h.mapped = 'contacts-slot';
		const { valueB64 } = await _getStorageJsonCodecForTests()!.encrypt({ contacts: { ann: ANN } });
		h.rows.set('contacts-slot', { valueB64, deletedFlag: false });
		h.writeStatus = 'queued';

		const result = await em.saveContacts({ bob: { user_hash: 'bob' } });
		expect(result.status).toBe('queued');
		expect(result.prior).toEqual({ state: 'readable', contacts: { ann: ANN } });
	});

	it('an existing slot with no readable row on this client is unknown, not empty', async () => {
		const em = await newManager();
		h.mapped = 'contacts-slot';
		h.writeStatus = 'awaiting-recovery';

		const result = await em.saveContacts({ ann: ANN });
		expect(result.status).toBe('awaiting-recovery');
		expect(result.prior).toEqual({ state: 'unknown' });
	});

	it('a slot another device created first, unread here, is unknown even though this write minted one', async () => {
		const em = await newManager();
		h.winner = 'winner-slot';

		const result = await em.saveContacts({ ann: ANN });
		expect(result.prior).toEqual({ state: 'unknown' });
	});
});
