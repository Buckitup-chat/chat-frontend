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
const keyMaterialFor = (userHash: string) => (userHash === A ? '11'.repeat(16) : '22'.repeat(16));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => ({ sign_skey: 'AAAA', crypt_skey: btoa(keyMaterialFor(ambientUserHash!)), evm_skey: 'cc' }),
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

describe('dispatchMutations: accepted-snapshot recording is fenced to the active session (§F-L05)', () => {
	it('does not record a late-arriving send whose owner logged out before it settled', async () => {
		startLeaderElection(A, () => {});
		stopLeaderElection(); // logout happens before the send below settles

		await dispatchMutations(message('dmsg_1', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_1')).toBeNull();
	});

	it('does not record a send belonging to a DIFFERENT account than the one now active', async () => {
		startLeaderElection(B, () => {}); // account B is signed in now

		await dispatchMutations(message('dmsg_2', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_2')).toBeNull();
	});

	it('still records normally when the owner matches the active session', async () => {
		startLeaderElection(A, () => {});

		await dispatchMutations(message('dmsg_3', A), async () => ({ txids: [1], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_3')).not.toBeNull();
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
});
