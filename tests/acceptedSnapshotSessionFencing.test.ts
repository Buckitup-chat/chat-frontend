import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchMutations } from '@/lib/data/coordinator';
import { startLeaderElection, stopLeaderElection, _setStorageForTests } from '@/lib/data/outbox';
import {
	getAccepted, getAllAcceptedForRelation, recordAccepted,
	_setAcceptedSnapshotStorageForTests, _setRawAcceptedSnapshotStorageForTests,
} from '@/lib/data/acceptedSnapshot';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);

let ambientUserHash: string | null = null;
let switchDuringExport: string | null = null;
const keyMaterialFor = (userHash: string) => (userHash === A ? '11'.repeat(16) : '22'.repeat(16));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => {
				if (switchDuringExport) {
					ambientUserHash = switchDuringExport;
					switchDuringExport = null;
				}
				return { sign_skey: 'AAAA', crypt_skey: btoa(keyMaterialFor(ambientUserHash!)), evm_skey: 'cc' };
			},
		}),
	},
}));

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const message = (id: string, senderHash: string) => ([{
	type: 'insert',
	modified: { message_id: id, sender_hash: senderHash, content_b64: 'x' },
	syncMetadata: { relation: 'dialog_messages' },
}]);

beforeEach(() => {
	_setStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

afterEach(() => {
	stopLeaderElection();
});

describe('dispatchMutations: accepted-snapshot recording only ever persists under its own row-owner\'s currently-unlocked account (§F-L05)', () => {
	beforeEach(() => {
		const map = new Map<string, string>();
		_setRawAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});
	});

	afterEach(() => {
		ambientUserHash = null;
	});

	it('does not record a late-arriving send whose owner is not unlocked at all (e.g. logged out before it settled)', async () => {
		ambientUserHash = null;

		await dispatchMutations(message('dmsg_1', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_1', A)).toBeNull();
	});

	it('does not record a send belonging to a DIFFERENT account than the one now unlocked', async () => {
		ambientUserHash = B;

		await dispatchMutations(message('dmsg_2', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_2', A)).toBeNull();
	});

	it('still records normally when the owner matches the currently-unlocked account', async () => {
		ambientUserHash = A;

		await dispatchMutations(message('dmsg_3', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_3', A)).not.toBeNull();
	});
});

describe('accepted-snapshot survives logout/relogin and stays isolated between accounts (§5)', () => {
	const acceptedRow = (id: string, senderHash: string) => ({
		message_id: id, dialog_hash: 'd1', sender_hash: senderHash, deleted_flag: false, sign_hash: 'dms_x', owner_timestamp: 1000,
	});

	beforeEach(() => {
		const map = new Map<string, string>();
		_setRawAcceptedSnapshotStorageForTests({
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		});
	});

	it('1. A accepted (without shape echo) → 2. logout A → 3. login B: A\'s state is unreadable, not exposed, scan still works → 4. logout B → 5. relogin A: A\'s own state is restored', async () => {
		ambientUserHash = A;
		startLeaderElection(A, () => {});
		await recordAccepted('dialog_messages', 'dmsg_a', acceptedRow('dmsg_a', A));
		expect(await getAccepted('dialog_messages', 'dmsg_a')).toMatchObject({ sender_hash: A });

		stopLeaderElection();
		ambientUserHash = null;
		ambientUserHash = B;
		startLeaderElection(B, () => {});
		expect(await getAccepted('dialog_messages', 'dmsg_a')).toBeNull();
		await expect(getAllAcceptedForRelation('dialog_messages')).resolves.toEqual([]);

		stopLeaderElection();
		ambientUserHash = null;

		ambientUserHash = A;
		startLeaderElection(A, () => {});
		expect(await getAccepted('dialog_messages', 'dmsg_a')).toEqual(acceptedRow('dmsg_a', A));
		expect(await getAllAcceptedForRelation('dialog_messages')).toEqual([acceptedRow('dmsg_a', A)]);
	});

	afterEach(() => {
		switchDuringExport = null;
	});

	it('a pinned recordAccepted throws, not silently encrypts under the new account, when the session switches mid-write', async () => {
		const { clearLocalStorageKey } = await import('@/lib/data/localCrypto');
		clearLocalStorageKey();
		ambientUserHash = A;
		startLeaderElection(A, () => {});
		switchDuringExport = B;

		await expect(
			recordAccepted('dialog_messages', 'dmsg_race', acceptedRow('dmsg_race', A), A)
		).rejects.toThrow(/no longer matches the pinned owner/);

		ambientUserHash = A;
		expect(await getAccepted('dialog_messages', 'dmsg_race', A)).toBeNull();
		stopLeaderElection();
		ambientUserHash = B;
		startLeaderElection(B, () => {});
		expect(await getAccepted('dialog_messages', 'dmsg_race', B)).toBeNull();
	});

	it('a pinned getAccepted throws rather than reading under the new account\'s key when the session switches mid-read', async () => {
		const { clearLocalStorageKey } = await import('@/lib/data/localCrypto');
		ambientUserHash = A;
		startLeaderElection(A, () => {});
		await recordAccepted('dialog_messages', 'dmsg_pinned', acceptedRow('dmsg_pinned', A), A);

		clearLocalStorageKey();
		switchDuringExport = B;
		await expect(getAccepted('dialog_messages', 'dmsg_pinned', A)).rejects.toThrow(/no longer matches the pinned owner/);
	});

	it('a pinned call with no session switch behaves exactly like the unpinned path', async () => {
		ambientUserHash = A;
		startLeaderElection(A, () => {});
		await recordAccepted('dialog_messages', 'dmsg_stable', acceptedRow('dmsg_stable', A), A);
		expect(await getAccepted('dialog_messages', 'dmsg_stable', A)).toEqual(acceptedRow('dmsg_stable', A));
	});
});
