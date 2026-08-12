import { describe, it, expect, beforeEach, vi } from 'vitest';

// Backend contract under test (chat/lib/chat/data/user.ex): a user_storage
// write is authorised through User.get_card(user_hash).sign_pkey, so the card
// must exist on the server before the profile is saved. Registration used to
// fire the card off without awaiting it.

const MY_NAME = 'Tester';

let order;
let cardRows;
let sendImpl;
let vaults;
let rawStore;

/** Minimal stand-in for a @lo-fi/local-vault vault. */
const makeVault = (id) => {
	const data = new Map();
	return {
		id,
		async set(k, v) {
			data.set(k, v);
		},
		async get(k) {
			return data.get(k);
		},
	};
};

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({
		async preload() {},
		get: (k) => cardRows.get(k),
		get toArray() {
			return [...cardRows.values()];
		},
	}),
}));

vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: (m) => sendImpl(m),
}));

vi.mock('@/lib/data/userStorage', () => ({
	STORAGE_SLOTS: { profile: 'uuid-profile', contacts: 'uuid-contacts' },
	getStorageRow: async () => null,
	upsertStorageRow: async () => {
		order.push('user_storage');
		return { sync: Promise.resolve({ status: 'synced' }) };
	},
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

const freshManager = () => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance();
};

beforeEach(() => {
	order = [];
	cardRows = new Map();
	vaults = new Map();
	const store = new Map();
	rawStore = {
		async get(k) {
			return store.get(k);
		},
		async set(k, v) {
			store.set(k, v);
		},
		async remove(k) {
			store.delete(k);
		},
	};
	// Default transport: accepted, and visible afterwards — the barrier is
	// what sendMutationsAndAwaitShape resolves on.
	sendImpl = async (mutations) => {
		for (const m of mutations) {
			const row = m.modified ?? m.changes;
			if (m.syncMetadata?.relation === 'user_cards') {
				order.push('user_cards');
				cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
			}
		}
		return { txids: [] };
	};
});

describe('registration publishes the user card before the profile', () => {
	it('waits for the card write to complete, not just to start', async () => {
		const em = freshManager();
		let cardResolved = false;
		const base = sendImpl;
		sendImpl = async (mutations) => {
			const isCard = mutations.some((m) => m.syncMetadata?.relation === 'user_cards');
			// A card write that takes real time is the whole point: a
			// fire-and-forget push would let the profile save overtake it.
			if (isCard) await new Promise((r) => setTimeout(r, 20));
			const result = await base(mutations);
			if (isCard) cardResolved = true;
			return result;
		};

		await em.createUserVault({ name: MY_NAME });

		expect(order).toEqual(['user_cards', 'user_storage']);
		expect(cardResolved).toBe(true);
	});

	it('does not save the profile at all if the card is rejected', async () => {
		const em = freshManager();
		sendImpl = async () => {
			throw new Error('card rejected');
		};

		await expect(em.createUserVault({ name: MY_NAME })).rejects.toThrow('card rejected');
		expect(order).not.toContain('user_storage');
	});
});

describe('user card owner_timestamp is monotonic', () => {
	// The server rejects a card update whose timestamp is not strictly newer
	// than the stored one, so two renames inside the same second must not
	// collide on Math.floor(Date.now() / 1000).
	const timestamps = () =>
		order.filter((o) => typeof o === 'object').map((o) => o.owner_timestamp);

	beforeEach(() => {
		sendImpl = async (mutations) => {
			for (const m of mutations) {
				const row = m.modified ?? m.changes;
				if (m.syncMetadata?.relation === 'user_cards') {
					order.push({ owner_timestamp: row.owner_timestamp });
					cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
				}
			}
			return { txids: [] };
		};
	});

	it('increases across two renames in the same second', async () => {
		const em = freshManager();
		await em.createUserVault({ name: MY_NAME });

		await em.updateOwnUserCardName('Second');
		await em.updateOwnUserCardName('Third');

		const ts = timestamps();
		expect(ts).toHaveLength(3);
		expect(ts[1]).toBeGreaterThan(ts[0]);
		expect(ts[2]).toBeGreaterThan(ts[1]);
	});

	it('increases when two renames are issued concurrently', async () => {
		const em = freshManager();
		await em.createUserVault({ name: MY_NAME });

		await Promise.all([
			em.updateOwnUserCardName('A'),
			em.updateOwnUserCardName('B'),
		]);

		const ts = timestamps();
		expect(ts).toHaveLength(3);
		expect(new Set(ts).size).toBe(3);
		expect(ts[1]).toBeGreaterThan(ts[0]);
		expect(ts[2]).toBeGreaterThan(ts[1]);
	});

	it('keeps the local registry and the published card in step', async () => {
		const em = freshManager();
		await em.createUserVault({ name: MY_NAME });

		await em.updateOwnUserCardName('Renamed');

		const local = await em.getLocalUserCards();
		expect(local[0].name).toBe('Renamed');
		expect([...cardRows.values()][0].name).toBe('Renamed');
	});
});
