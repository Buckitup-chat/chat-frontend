import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const SKEY = new Uint8Array(32);

let online = true;
const sent: unknown[][] = [];

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			if (!online) throw new TypeError('Failed to fetch');
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({
					results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })),
				}),
			} as unknown as Response;
		},
	},
}));

const { sendMutationsAndAwaitShape, drainPendingWrites } = await import('@/lib/data/ingest');
const {
	dependenciesFor, reconcileAccepted,
} = await import('@/lib/data/coordinator');
const {
	enqueue, discardEntry, requeueEntry, awaitEntryOutcome, drainOutbox,
	quarantinedEntries, pendingEntries, pendingReconciliation, readyEntries, blockedDependentIssues,
	startLeaderElection, stopLeaderElection,
	stopDrainLoop, _setStorageForTests, _setLeaderForTests,
} = await import('@/lib/data/outbox');
const { getAccepted, _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeMemoryStore = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const makeSelectiveFailStore = (shouldFail: (parsed: Record<string, unknown>) => boolean) => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) {
			if (shouldFail(JSON.parse(v))) throw new Error('storage down for this exact write');
			map.set(k, v);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const makeToggleFailStore = (armed: { value: boolean }) => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) {
			if (armed.value) throw new Error('storage down');
			map.set(k, v);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const message = (text: string, userHash = MY_HASH) => ([{
	type: 'insert',
	modified: {
		message_id: `dmsg_${text}`, sender_hash: userHash, dialog_hash: 'dh1',
		content_b64: text, deleted_flag: false, parent_sign_hash: null, owner_timestamp: 1,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const editMessage = (messageId: string, text: string, userHash = MY_HASH) => ([{
	type: 'update',
	modified: {
		message_id: messageId, sender_hash: userHash, dialog_hash: 'dh1',
		content_b64: text, parent_sign_hash: null, owner_timestamp: 2,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const dialogKeyRow = (dialogHash: string, userHash = MY_HASH) => ([{
	type: 'insert',
	modified: {
		dialog_hash: dialogHash, sender_hash: userHash, peer_hash: 'peer1',
		owner_timestamp: 1, deleted_flag: false,
	},
	syncMetadata: { relation: 'dialog_keys' },
}]);

beforeEach(() => {
	online = true;
	sent.length = 0;
	_setStorageForTests(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

describe('L17-10 A: accepted snapshot (local reconciliation) failure never repeats transport', () => {
	it('server accepts once; recordAccepted fails; entry stays server_accepted_pending_reconcile, not quarantined, not resent; storage recovery finishes it with no extra transport', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		const handle = await sendMutationsAndAwaitShape(message('acc-fail'), SKEY, { retries: 0 });

		expect(handle.phase).toBe('accepted');
		expect(sent).toHaveLength(1);

		const stuck = await pendingReconciliation(MY_HASH);
		expect(stuck.map((e) => e.id)).toContain(handle.outboxId);
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
		expect(await getAccepted('dialog_messages', 'dmsg_acc-fail')).toBeNull();

		failing.value = false;
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingReconciliation(MY_HASH)).toHaveLength(0));
		expect(sent).toHaveLength(1);

		const accepted = await getAccepted('dialog_messages', 'dmsg_acc-fail');
		expect(accepted?.message_id).toBe('dmsg_acc-fail');
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
	});
});

describe('L17-10 B: reload after the durable server-accepted phase resumes reconciliation, not the send', () => {
	it('a reload (fresh storage handles) never repeats HTTP or re-signs; startup scan finishes reconciliation from the durable server-accepted phase', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		const backing = makeMemoryStore();
		_setStorageForTests(backing);

		const handle = await sendMutationsAndAwaitShape(message('reload-b'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('accepted');
		expect(sent).toHaveLength(1);
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

		_setStorageForTests({ ...backing });
		failing.value = false;

		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingReconciliation(MY_HASH)).toHaveLength(0));

		expect(sent).toHaveLength(1);
		const accepted = await getAccepted('dialog_messages', 'dmsg_reload-b');
		expect(accepted?.message_id).toBe('dmsg_reload-b');
	});
});

describe('L17-10 C: a terminal-marker write failure alone never re-arms transport', () => {
	it('accepted snapshot succeeds; only the terminal marker write fails; entry never re-enters the HTTP-ready queue; recovery finishes it locally', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});

		let failMarker = true;
		_setStorageForTests(makeSelectiveFailStore((parsed) => failMarker && parsed.status === 'accepted'));

		const handle = await sendMutationsAndAwaitShape(message('marker-fail'), SKEY, { retries: 0 });

		expect(handle.phase).toBe('accepted');
		expect(sent).toHaveLength(1);
		expect((await getAccepted('dialog_messages', 'dmsg_marker-fail'))?.message_id).toBe('dmsg_marker-fail');
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });

		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(handle.outboxId);

		failMarker = false;
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingReconciliation(MY_HASH)).toHaveLength(0));
		expect(sent).toHaveLength(1);
	});
});

describe('L17-10 D: dependency behavior distinguishes server-accepted from fully reconciled', () => {
	it('a dialog-key dependent (message) may dispatch once the key is merely server-accepted, before its own terminal marker lands', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});

		let failMarker = true;
		_setStorageForTests(makeSelectiveFailStore((parsed) => failMarker && parsed.status === 'accepted'));

		const keysHandle = await sendMutationsAndAwaitShape(dialogKeyRow('dh1'), SKEY, { retries: 0 });
		expect(keysHandle.phase).toBe('accepted');
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(keysHandle.outboxId);

		const deps = await dependenciesFor(message('needs-key'), MY_HASH);
		expect(deps).toContain(keysHandle.outboxId);

		const depId = await enqueue(message('needs-key'), MY_HASH, { dependsOn: deps });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(depId);

		expect((await blockedDependentIssues(MY_HASH)).some((i) => i.entry.id === depId)).toBe(false);

		failMarker = false;
	});

	it('a fresh chained edit of the SAME message is immediately dispatch-ready even though its recorded predecessor is only server-accepted, not yet terminal', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});

		let failMarker = true;
		_setStorageForTests(makeSelectiveFailStore((parsed) => failMarker && parsed.status === 'accepted'));

		const handle = await sendMutationsAndAwaitShape(message('chain-a'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('accepted');
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

		const deps = await dependenciesFor(editMessage('dmsg_chain-a', 'v2'), MY_HASH);
		expect(deps).toContain(handle.outboxId);
		const editId = await enqueue(editMessage('dmsg_chain-a', 'v2'), MY_HASH, { dependsOn: deps });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(editId);

		failMarker = false;
	});

	it('an unrelated independent write dispatches normally while another entry is stuck reconciling', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		await sendMutationsAndAwaitShape(message('stuck'), SKEY, { retries: 0 });
		expect(sent).toHaveLength(1);

		const other = await sendMutationsAndAwaitShape(message('independent'), SKEY, { retries: 0 });
		expect(other.phase).toBe('accepted');
		expect(sent).toHaveLength(2);

		failing.value = false;
	});

	it('reload does not change the dependency verdict', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		let failMarker = true;
		const backing = makeSelectiveFailStore((parsed) => failMarker && parsed.status === 'accepted');
		_setStorageForTests(backing);

		const keysHandle = await sendMutationsAndAwaitShape(dialogKeyRow('dh1'), SKEY, { retries: 0 });
		const deps = await dependenciesFor(message('after-reload'), MY_HASH);
		const depId = await enqueue(message('after-reload'), MY_HASH, { dependsOn: deps });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(depId);

		_setStorageForTests({ ...backing });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(depId);
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(keysHandle.outboxId);

		failMarker = false;
	});

	it('discard and requeue are both no-ops on a server_accepted_pending_reconcile entry', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		const handle = await sendMutationsAndAwaitShape(message('no-discard'), SKEY, { retries: 0 });
		const id = handle.outboxId as string;

		await discardEntry(id);
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(id);

		await requeueEntry(id);
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(id);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(id); // never re-armed for transport

		failing.value = false;
	});

	it('a reconciliation failure never shows up as quarantine to the UI', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		await sendMutationsAndAwaitShape(message('not-a-rejection'), SKEY, { retries: 0 });

		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
		expect(await blockedDependentIssues(MY_HASH)).toEqual([]);

		failing.value = false;
	});
});

describe('L17-10 E: account/session fencing on reconciliation', () => {
	it('a late reconciliation for account A while B is the active session never applies A\'s base, and A\'s own relogin resumes it', async () => {
		startLeaderElection(MY_HASH, () => {});
		_setLeaderForTests(true);
		const failing = { value: true };
		_setAcceptedSnapshotStorageForTests(makeToggleFailStore(failing));

		const handle = await sendMutationsAndAwaitShape(message('fenced', MY_HASH), SKEY, { retries: 0 });
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

		startLeaderElection(OTHER_HASH, () => {});
		failing.value = false;
		drainPendingWrites(MY_HASH, SKEY);
		await new Promise((r) => setTimeout(r, 30));

		expect(await getAccepted('dialog_messages', 'dmsg_fenced')).toBeNull();
		expect((await pendingReconciliation(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

		startLeaderElection(MY_HASH, () => {});
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingReconciliation(MY_HASH)).toHaveLength(0));
		expect((await getAccepted('dialog_messages', 'dmsg_fenced'))?.message_id).toBe('dmsg_fenced');
	});
});

describe('L17-10 G: the queued/replay path (drainOutbox itself) never compacts on a local reconciliation failure', () => {
	it('reconcile() throwing inside drainOutbox leaves the entry stuck in server_accepted_pending_reconcile with its mutations, never ready/quarantined/terminal, and the next drain finishes it with no second HTTP call', async () => {
		_setLeaderForTests(true);
		const outboxId = await enqueue(message('replay-reconcile-fail'), MY_HASH, {});
		expect(outboxId).toBeTruthy();

		let reconcileShouldFail = true;
		const reconcile = async (mutations: unknown[], result?: unknown) => {
			if (reconcileShouldFail) throw new Error('reconciliation down');
			await reconcileAccepted(mutations, result);
		};
		const send = async (mutations: unknown[]) => { sent.push(mutations); return { txids: [101] }; };

		const first = await drainOutbox(MY_HASH, send, reconcile);
		expect(first.sent).toBe(1);
		expect(sent).toHaveLength(1);

		let stuck = await pendingReconciliation(MY_HASH);
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(outboxId);
		expect(stuck[0].mutations).not.toEqual([]);
		expect(stuck[0].reconciledAt).toBeUndefined();

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(outboxId);
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);

		reconcileShouldFail = false;
		const second = await drainOutbox(MY_HASH, send, reconcile);

		expect(sent).toHaveLength(1);
		expect(second.sent).toBe(0); // nothing left in readyEntries — this pass only reconciled

		stuck = await pendingReconciliation(MY_HASH);
		expect(stuck).toHaveLength(0);
		await expect(awaitEntryOutcome(outboxId!, MY_HASH)).resolves.toEqual({ kind: 'accepted' });
	});

	it('markReconciled() itself failing to persist leaves reconciledAt unset and the entry non-terminal, even though reconcile() succeeded', async () => {
		_setLeaderForTests(true);
		_setStorageForTests(makeSelectiveFailStore((parsed) => parsed.status === 'server_accepted_pending_reconcile' && !!parsed.reconciledAt));
		const outboxId = await enqueue(message('markreconciled-fail'), MY_HASH, {});
		const send = async (mutations: unknown[]) => { sent.push(mutations); return {}; };
		const reconcile = async () => {}; // local reconciliation logic itself succeeds

		const result = await drainOutbox(MY_HASH, send, reconcile);
		expect(result.sent).toBe(1);
		expect(sent).toHaveLength(1);

		const stuck = await pendingReconciliation(MY_HASH);
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(outboxId);
		expect(stuck[0].reconciledAt).toBeUndefined(); // the durable write that would have set this failed
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
	});

	it('drainOutbox with no reconcile callback at all is an explicit opt-out (resolves immediately), not a silently-assumed success', async () => {
		_setLeaderForTests(true);
		const outboxId = await enqueue(message('no-reconcile-callback'), MY_HASH, {});
		const send = async (mutations: unknown[]) => { sent.push(mutations); return {}; };

		const result = await drainOutbox(MY_HASH, send); // no reconcile argument at all

		expect(result.sent).toBe(1);
		expect(await pendingReconciliation(MY_HASH)).toHaveLength(0); // never entered reconciliation in the first place
		await expect(awaitEntryOutcome(outboxId!, MY_HASH)).resolves.toEqual({ kind: 'accepted' });
	});
});

describe('L17-10 F: the unavoidable first-write failure is left honestly open', () => {
	it('when the very first durable write of server-acceptance itself fails, the entry is indistinguishable from an unknown HTTP outcome and IS replayed', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});

		let armed = true;
		_setStorageForTests(makeSelectiveFailStore((parsed) => {
			if (armed && parsed.status === 'server_accepted_pending_reconcile') {
				armed = false;
				return true;
			}
			return false;
		}));

		await expect(sendMutationsAndAwaitShape(message('first-write-fail'), SKEY, { retries: 0 })).rejects.toThrow();
		expect(sent).toHaveLength(1);

		expect(await pendingReconciliation(MY_HASH)).toHaveLength(0);
		const pending = await pendingEntries(MY_HASH);
		const entry = pending.find((e) => e.relation === 'dialog_messages');
		expect(entry).toBeTruthy();
		const outboxId = entry!.id;

		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		await expect(awaitEntryOutcome(outboxId, MY_HASH)).resolves.toEqual({ kind: 'accepted' });
	});
});
