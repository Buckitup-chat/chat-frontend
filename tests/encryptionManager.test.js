import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordAccepted, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';

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
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		async preload() {},
		get: (k) => cardRows.get(k),
		get toArray() {
			return [...cardRows.values()];
		},
	}),
}));

vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (m) => {
		const result = await sendImpl(m);
		if (result && typeof result === 'object' && 'phase' in result) return result;
		return { outboxId: 'test-outbox-id', phase: 'accepted', result, acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
	// Login triggers a background outbox drain; irrelevant to these tests.
	drainPendingWrites: async () => {},
	stopDrainLoop: () => {},
}));


vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	upsertStorageRow: async () => {
		order.push('user_storage');
		return { sync: Promise.resolve({ status: 'synced' }) };
	},
	upsertStorageJsonPatch: async () => {
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
	_setAcceptedSnapshotStorageForTests({
		_map: new Map(),
		async get(k) { return this._map.get(k) ?? null; },
		async set(k, v) { this._map.set(k, v); },
		async delete(k) { this._map.delete(k); },
		async keys() { return [...this._map.keys()]; },
		async clear() { this._map.clear(); },
	});
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

describe('user_cards base does not go stale under shape lag (L17-01/backend-report R4)', () => {
	it('a second rapid update does not start signing until the first write\'s real acceptance is known (follower/queued path)', async () => {
		const em = freshManager();
		await em.createUserVault({ name: MY_NAME });

		const applied = [];
		let resolveFirstAcceptance;
		let callCount = 0;
		sendImpl = async (mutations) => {
			const row = mutations[0].modified ?? mutations[0].changes;
			callCount++;
			if (callCount === 1) {
				const acceptance = new Promise((resolve) => {
					resolveFirstAcceptance = () => {
						cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
						applied.push(row.owner_timestamp);
						resolve({ kind: 'accepted' });
					};
				});
				return { outboxId: 'ob-1', phase: 'queued', acceptance };
			}
			cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
			applied.push(row.owner_timestamp);
			return { txids: [] };
		};

		const firstUpdate = em.updateOwnUserCardName('Second');
		await vi.waitFor(() => expect(callCount).toBe(1));

		const secondUpdate = em.updateOwnUserCardName('Third');
		await new Promise((r) => setTimeout(r, 20));
		expect(callCount).toBe(1);

		resolveFirstAcceptance();
		await firstUpdate;
		await secondUpdate;

		expect(callCount).toBe(2);
		expect(applied).toHaveLength(2);
		expect(applied[1]).toBeGreaterThan(applied[0]); // strictly monotonic, not a stale-base collision
		expect([...cardRows.values()][0].name).toBe('Third');
	});

	it('a second update computes its base from the locally-accepted card, not a stale shape read', async () => {
		const em = freshManager();
		await em.createUserVault({ name: MY_NAME });
		const userHash = [...cardRows.keys()][0];
		const staleShapeRow = cardRows.get(userHash);

		const acceptedButNotYetVisible = {
			...staleShapeRow,
			name: 'AcceptedElsewhere',
			owner_timestamp: staleShapeRow.owner_timestamp + 50,
		};
		await recordAccepted('user_cards', userHash, acceptedButNotYetVisible);

		let sentTimestamp = null;
		sendImpl = async (mutations) => {
			const row = mutations[0].modified ?? mutations[0].changes;
			sentTimestamp = row.owner_timestamp;
			return { txids: [] };
		};

		await em.updateOwnUserCardName('Renamed');

		expect(sentTimestamp).toBeGreaterThan(acceptedButNotYetVisible.owner_timestamp);
		expect(sentTimestamp).toBeGreaterThan(staleShapeRow.owner_timestamp);
	});
});

describe('#pushOwnCard survives a failed local accepted-snapshot write without exposing a stale base to the next call (L17-01/R4)', () => {
	it('1-6. A is HTTP accepted, its local snapshot write fails, and B still gets a strictly newer timestamp — with no repeated HTTP call for A', async () => {
		const em = freshManager();

		let snapshotWriteAttempts = 0;
		let failFirstWrite = true;
		const map = new Map();
		_setAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) {
				snapshotWriteAttempts++;
				if (failFirstWrite) { failFirstWrite = false; throw new Error('storage temporarily unavailable'); }
				map.set(k, v);
			},
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});

		let httpCallCount = 0;
		let aTimestamp = null;
		sendImpl = async (mutations) => {
			httpCallCount++;
			aTimestamp = (mutations[0].modified ?? mutations[0].changes).owner_timestamp;
			return { txids: [] };
		};

		await em.createUserVault({ name: 'Tester' });
		expect(httpCallCount).toBe(1); // A's own HTTP call
		expect(cardRows.size).toBe(0); // shape confirmed stale

		expect(httpCallCount).toBe(1);

		let bTimestamp = null;
		sendImpl = async (mutations) => {
			httpCallCount++;
			bTimestamp = (mutations[0].modified ?? mutations[0].changes).owner_timestamp;
			return { txids: [] };
		};
		await em.updateOwnUserCardName('Renamed');

		expect(cardRows.size).toBe(0); // still stale — B's base did not come from the shape
		expect(bTimestamp).toBeGreaterThan(aTimestamp); // no stale-base collision
		expect(httpCallCount).toBe(2); // exactly one HTTP call per card write — no bookkeeping-only resend
		expect(snapshotWriteAttempts).toBeGreaterThanOrEqual(1); // the failed write really was attempted
	});

	it('7. once local storage recovers, the accepted snapshot eventually reflects the latest accepted row', async () => {
		const em = freshManager();

		let broken = true;
		const map = new Map();
		_setAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { if (broken) throw new Error('storage down'); map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});

		await em.createUserVault({ name: 'Tester' });
		const userHash = (await em.getLocalUserCards())[0].user_hash;
		expect(await getAcceptedUserCard(userHash)).toBeNull(); // still down after A

		broken = false;
		await em.updateOwnUserCardName('Renamed');

		const accepted = await getAcceptedUserCard(userHash);
		expect(accepted).toBeTruthy();
		expect(accepted.name).toBe('Renamed'); // the latest accepted row, not the lost first one — both are covered
	});

	it('8. an account switch between the failure and reconciliation never records A\'s row under B', async () => {
		const emA = freshManager();
		let broken = true;
		const map = new Map();
		_setAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { if (broken) throw new Error('storage down'); map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});

		await emA.createUserVault({ name: 'Alice' });
		const hashA = (await emA.getLocalUserCards()).find((c) => c.name === 'Alice').user_hash;
		expect(await getAcceptedUserCard(hashA)).toBeNull();

		broken = false;
		const emB = freshManager();
		await emB.createUserVault({ name: 'Bob' });
		const hashB = (await emB.getLocalUserCards()).find((c) => c.name === 'Bob').user_hash;

		const acceptedB = await getAcceptedUserCard(hashB);
		expect(acceptedB.name).toBe('Bob');
		expect(acceptedB.user_hash).toBe(hashB);
		const acceptedAStill = await getAcceptedUserCard(hashA);
		if (acceptedAStill) expect(acceptedAStill.user_hash).toBe(hashA); // never resurrected under B
	});

	it('9. LIMITATION: a reload before the durable snapshot write ever lands loses the session-local continuation and can re-collide on owner_timestamp', async () => {
		const em = freshManager();
		let broken = true;
		const map = new Map();
		_setAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { if (broken) throw new Error('storage down'); map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});
		let aTimestamp = null;
		sendImpl = async (mutations) => {
			aTimestamp = (mutations[0].modified ?? mutations[0].changes).owner_timestamp;
			return { txids: [] }; // cardRows deliberately untouched — shape stays stale
		};
		await em.createUserVault({ name: 'Tester' });
		const userHash = (await em.getLocalUserCards())[0].user_hash;
		expect(await getAcceptedUserCard(userHash)).toBeNull(); // durable write never landed

		EncryptionManagerPQ._clearAcceptedCardCacheForTests();
		const em2 = freshManager();
		await em2.login(userHash); // a real reload logs back in the same account

		let bTimestamp = null;
		sendImpl = async (mutations) => {
			bTimestamp = (mutations[0].modified ?? mutations[0].changes).owner_timestamp;
			return { txids: [] };
		};
		await em2.updateOwnUserCardName('Second try');

		expect(bTimestamp).not.toBeNull();
		expect(aTimestamp).not.toBeNull();
	});
});

async function getAcceptedUserCard(userHash) {
	const { getAccepted } = await import('@/lib/data/acceptedSnapshot');
	return getAccepted('user_cards', userHash);
}
