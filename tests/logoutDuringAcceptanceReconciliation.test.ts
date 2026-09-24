import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const SKEY_A = new Uint8Array(32).fill(1);
const SKEY_B = new Uint8Array(32).fill(2);

const sent: unknown[][] = [];
let releaseHttp: (() => void) | null = null;
let requestStarted: (() => void) | null = null;

let ambientUserHash: string | null = null;
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => ({
				sign_skey: 'AAAA',
				crypt_skey: btoa((ambientUserHash === A ? '11' : '22').repeat(16)),
				evm_skey: 'cc',
			}),
		}),
	},
}));

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			sent.push(mutations);
			requestStarted?.();
			await new Promise<void>((resolve) => { releaseHttp = resolve; });
			return {
				status: 200,
				json: async () => ({
					results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })),
				}),
			} as unknown as Response;
		},
	},
}));

const { sendMutationsAndAwaitShape } = await import('@/lib/data/ingest');
const { reconcileAccepted } = await import('@/lib/data/coordinator');
const {
	pendingEntries, pendingReconciliation, readyEntries, awaitEntryOutcome, drainOutbox,
	startLeaderElection, stopLeaderElection, stopDrainLoop, currentSessionUserHash,
	_setStorageForTests, _setLeaderForTests,
} = await import('@/lib/data/outbox');
const { getAccepted, _setRawAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeMemoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const message = (text: string, userHash: string) => ([{
	type: 'insert',
	modified: {
		message_id: `dmsg_${text}`, sender_hash: userHash, dialog_hash: 'dh1',
		content_b64: text, deleted_flag: false, parent_sign_hash: null, owner_timestamp: 1,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

beforeEach(() => {
	sent.length = 0;
	releaseHttp = null;
	requestStarted = null;
	ambientUserHash = null;
	_setStorageForTests(makeMemoryStore());
	_setRawAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

describe('acceptance arriving after the owner logged out mid-request', () => {
	it('durable enqueue precedes HTTP; logout races the open request; acceptance lands with nobody signed in; B cannot finish it; only A\'s relogin durably reconciles it; transport fires exactly once', async () => {
		startLeaderElection(A, () => {});
		ambientUserHash = A;

		const started = new Promise<void>((resolve) => { requestStarted = resolve; });
		const handlePromise = sendMutationsAndAwaitShape(message('logout-race', A), SKEY_A, { retries: 0 });

		await started;
		const inFlight = await pendingEntries(A);
		expect(inFlight).toHaveLength(1);
		const outboxId = inFlight[0].id;
		expect(inFlight[0].mutations).not.toEqual([]);

		stopLeaderElection();
		stopDrainLoop();
		ambientUserHash = null;
		expect(currentSessionUserHash()).toBeNull();

		releaseHttp!();
		const handle = await handlePromise;
		expect(handle.phase).toBe('accepted');
		expect(sent).toHaveLength(1);

		const stuckAfterLogout = await pendingReconciliation(A);
		expect(stuckAfterLogout.map((e) => e.id)).toContain(outboxId);
		const stuckEntry = stuckAfterLogout.find((e) => e.id === outboxId)!;
		expect(stuckEntry.status).toBe('server_accepted_pending_reconcile');
		expect(stuckEntry.reconciledAt).toBeUndefined();
		expect(stuckEntry.mutations).not.toEqual([]);
		expect((await readyEntries(A)).map((e) => e.id)).not.toContain(outboxId);
		expect(await getAccepted('dialog_messages', 'dmsg_logout-race', A)).toBeNull();

		startLeaderElection(B, () => {});
		ambientUserHash = B;
		const sendMustNotFire = async () => { throw new Error('transport must not be called again'); };
		const drainUnderB = await drainOutbox(A, sendMustNotFire, reconcileAccepted);
		expect(drainUnderB.sent).toBe(0);
		expect(sent).toHaveLength(1);

		expect(await getAccepted('dialog_messages', 'dmsg_logout-race', A)).toBeNull();
		const stuckUnderB = await pendingReconciliation(A);
		expect(stuckUnderB.map((e) => e.id)).toContain(outboxId);
		expect(stuckUnderB.find((e) => e.id === outboxId)!.reconciledAt).toBeUndefined();

		stopLeaderElection();
		ambientUserHash = null;
		startLeaderElection(A, () => {});
		ambientUserHash = A;
		const finalDrain = await drainOutbox(A, sendMustNotFire, reconcileAccepted);
		expect(finalDrain.sent).toBe(0);
		expect(sent).toHaveLength(1);

		expect(await pendingReconciliation(A)).toHaveLength(0);
		expect((await getAccepted('dialog_messages', 'dmsg_logout-race', A))?.message_id).toBe('dmsg_logout-race');
		await expect(awaitEntryOutcome(outboxId, A)).resolves.toEqual({ kind: 'accepted' });
	});
});
