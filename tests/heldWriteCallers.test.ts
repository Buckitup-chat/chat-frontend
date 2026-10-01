import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);
const sent: unknown[][] = [];
let signatures = 0;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			currentUserHash: null,
			exportVaultKeys: async () => { throw new Error('locked'); },
		}),
	},
}));

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			signatures++;
			const signed = { ...row, sign_b64: `sig-${signatures}` };
			return type === 'insert'
				? { type, modified: signed, syncMetadata: { relation } }
				: { type, original: {}, changes: signed, syncMetadata: { relation } };
		},
		createStorageMutation: (userHash: string, uuid: string, valueB64: string, _a: unknown, _b: unknown, ts: number,
			_skey: unknown, _c: unknown, del: boolean, parent: string | null, _d: unknown, _e: unknown, type: string) => {
			signatures++;
			const changes = { user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: del, owner_timestamp: ts, parent_sign_hash: parent, sign_b64: `sig-${signatures}` };
			return type === 'insert'
				? { type, modified: changes, syncMetadata: { relation: 'user_storage' } }
				: { type, original: { user_hash: userHash, uuid }, changes, syncMetadata: { relation: 'user_storage' } };
		},
		ingestWithAuthEach: async (mutations: unknown[]) => {
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const { enqueueIntent, getIntent, _setIntentStorageForTests } = await import('@/lib/data/intents');
const outboxModule = await import('@/lib/data/outbox');
const { pendingEntries, blockedDependentIssues, _setStorageForTests, _setLeaderForTests } = outboxModule;
const { markUnconfirmed, _resetStaleBase } = await import('@/lib/data/staleBase');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeStore = () => {
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

const settledWithin = async (promise: Promise<unknown>, ms = 30): Promise<boolean> =>
	Promise.race([promise.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

const settleLoop = async (o: { stopDrainLoop(): void; _drainLoopSettledForTests(): Promise<void> }): Promise<void> => {
	o.stopDrainLoop();
	await o._drainLoopSettledForTests();
};

let outboxStore: ReturnType<typeof makeStore>;
let intentStore: ReturnType<typeof makeStore>;

beforeEach(() => {
	sent.length = 0;
	signatures = 0;
	outboxStore = makeStore();
	intentStore = makeStore();
	_setStorageForTests(outboxStore);
	_setIntentStorageForTests(intentStore);
	_setAcceptedSnapshotStorageForTests(makeStore());
	_setLeaderForTests(true);
	_resetStaleBase();
});

afterEach(async () => {
	await settleLoop(outboxModule);
	_setLeaderForTests(null);
	_resetStaleBase();
});

const cases = [
	{
		name: 'a message edit',
		scope: 'dialog_messages|dh1',
		readyRow: {
			kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update',
			row: { message_id: 'dmsg_1', dialog_hash: 'dh1', sender_hash: MY_HASH, content_b64: 'edited', deleted_flag: false, parent_sign_hash: 'dms_x', owner_timestamp: 2 },
		},
	},
	{
		name: 'a message delete',
		scope: 'dialog_messages|dh1',
		readyRow: {
			kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update',
			row: { message_id: 'dmsg_1', dialog_hash: 'dh1', sender_hash: MY_HASH, content_b64: null, deleted_flag: true, parent_sign_hash: 'dms_x', owner_timestamp: 3 },
		},
	},
	{
		name: 'a user_storage update',
		scope: `user_storage|${MY_HASH}`,
		readyRow: {
			kind: 'ready-row', relation: 'user_storage', mutationType: 'update',
			row: { user_hash: MY_HASH, uuid: 'slot-1', value_b64: 'v2', owner_timestamp: 2, parent_sign_hash: 'uss_x' },
		},
	},
] as const;

describe('a write held for an unconfirmed base is queued, not failed', () => {
	it.each(cases)('$name: the caller gets a queued, held handle; nothing is sent; acceptance stays open', async ({ scope, readyRow }) => {
		markUnconfirmed(scope);
		const intentId = await enqueueIntent(readyRow, MY_HASH, readyRow.relation) as string;

		const handle = await signAndDispatchIntent(intentId, readyRow as never, SKEY);

		expect(handle.phase).toBe('queued');
		expect(handle.held).toEqual({ reason: 'stale_base', message: 'it was built on data the server has not confirmed yet — it waits until that data is confirmed' });
		expect(sent).toEqual([]);
		expect(await settledWithin(handle.acceptance)).toBe(false);
		const [entry] = await pendingEntries(MY_HASH);
		expect(entry).toMatchObject({ id: handle.outboxId, sourceIntentId: intentId });
		expect((await getIntent<Record<string, unknown>>(intentId))?.intent).toMatchObject({ resolved: true, ref: handle.outboxId });
		const issue = (await blockedDependentIssues(MY_HASH)).find((i) => i.entry.id === handle.outboxId);
		expect(issue?.discovery?.reason).toBe('stale_base');
	});

	it.each(cases)('$name: retrying the same intent reuses the held write — no second signature, no second snapshot', async ({ scope, readyRow }) => {
		markUnconfirmed(scope);
		const intentId = await enqueueIntent(readyRow, MY_HASH, readyRow.relation) as string;
		const first = await signAndDispatchIntent(intentId, readyRow as never, SKEY);

		const again = await signAndDispatchIntent(intentId, readyRow as never, SKEY);

		expect(again.outboxId).toBe(first.outboxId);
		expect(again.phase).toBe('queued');
		expect(again.held).toEqual(first.held);
		expect(await settledWithin(again.acceptance)).toBe(false);
		expect(signatures).toBe(1);
		expect((await pendingEntries(MY_HASH)).map((e) => e.id)).toEqual([first.outboxId]);
		expect(sent).toEqual([]);
	});
});

const reloadModules = async () => {
	await settleLoop(outboxModule);
	vi.resetModules();
	const m = {
		intentRecovery: await import('@/lib/data/intentRecovery'),
		intents: await import('@/lib/data/intents'),
		outbox: await import('@/lib/data/outbox'),
		coordinator: await import('@/lib/data/coordinator'),
		ingest: await import('@/lib/data/ingest'),
	};
	m.outbox._setStorageForTests(outboxStore);
	m.intents._setIntentStorageForTests(intentStore);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStore());
	m.outbox._setLeaderForTests(true);
	return m;
};

describe('a retried handle reports the write as held exactly while its stored block holds', () => {
	it.each(cases)('$name: after a real reload the retry still reports the same held state, with one signature and one snapshot', async ({ scope, readyRow }) => {
		markUnconfirmed(scope);
		const intentId = await enqueueIntent(readyRow, MY_HASH, readyRow.relation) as string;
		const first = await signAndDispatchIntent(intentId, readyRow as never, SKEY);

		const m = await reloadModules();
		try {
			const again = await m.intentRecovery.signAndDispatchIntent(intentId, readyRow as never, SKEY);

			expect(again.outboxId).toBe(first.outboxId);
			expect(again.held).toEqual(first.held);
			expect(await settledWithin(again.acceptance)).toBe(false);
			expect(signatures).toBe(1);
			expect((await m.outbox.pendingEntries(MY_HASH)).map((e) => e.id)).toEqual([first.outboxId]);
			expect(sent).toEqual([]);
		} finally {
			await settleLoop(m.outbox);
			m.outbox._setLeaderForTests(null);
		}
	});

	it.each(cases)('$name: once a stored confirmation lets recovery release it, a retried handle no longer reports held', async ({ scope, readyRow }) => {
		markUnconfirmed(scope);
		const intentId = await enqueueIntent(readyRow, MY_HASH, readyRow.relation) as string;
		const first = await signAndDispatchIntent(intentId, readyRow as never, SKEY);
		await settleLoop(outboxModule);
		expect(sent).toEqual([]);

		const m = await reloadModules();
		try {
			await m.coordinator.confirmScope(scope);
			await m.outbox.drainOutbox(MY_HASH, async (mutations) => { sent.push(mutations); }, undefined, undefined, m.ingest.rediscoverDependencies);
			expect(sent).toHaveLength(1);

			const again = await m.intentRecovery.signAndDispatchIntent(intentId, readyRow as never, SKEY);

			expect(again.outboxId).toBe(first.outboxId);
			expect(again).not.toHaveProperty('held');
			await expect(again.acceptance).resolves.toEqual({ kind: 'accepted' });
			expect(signatures).toBe(1);
			expect(sent).toHaveLength(1);
		} finally {
			await settleLoop(m.outbox);
			m.outbox._setLeaderForTests(null);
		}
	});
});

describe('a rebuilt handle is unheld only when its stored entry was read and proven clear', () => {
	const STATE_UNCONFIRMED = { reason: 'state_unconfirmed', message: 'its stored state cannot be read right now — it is not sent until it can be' };
	const STALE_HELD = { reason: 'stale_base', message: 'it was built on data the server has not confirmed yet — it waits until that data is confirmed' };
	const EDIT = cases[0];

	const failEntryReads = (id: string) => {
		const failing = { value: true };
		const realGet = outboxStore.get.bind(outboxStore);
		outboxStore.get = async (k: string) => {
			if (failing.value && k === id) throw new Error('disk read error');
			return realGet(k);
		};
		return failing;
	};
	const entryKeys = () => [...outboxStore.map.keys()].filter((k) => !k.includes('|'));

	const heldWrite = async () => {
		markUnconfirmed(EDIT.scope);
		const intentId = await enqueueIntent(EDIT.readyRow, MY_HASH, EDIT.readyRow.relation) as string;
		const first = await signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);
		await settleLoop(outboxModule);
		return { intentId, first, intentBefore: intentStore.map.get(intentId) };
	};

	it('immediate retry with the entry unreadable: held as state_unconfirmed — no signature, snapshot, HTTP or relinking — then the real state once readable', async () => {
		const { intentId, first, intentBefore } = await heldWrite();
		const failing = failEntryReads(first.outboxId as string);

		const again = await signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);

		expect(again.outboxId).toBe(first.outboxId);
		expect(again.held).toEqual(STATE_UNCONFIRMED);
		expect(await settledWithin(again.acceptance)).toBe(false);
		expect(signatures).toBe(1);
		expect(entryKeys()).toEqual([first.outboxId]);
		expect(sent).toEqual([]);
		expect(intentStore.map.get(intentId)).toBe(intentBefore);

		failing.value = false;
		const readable = await signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);
		expect(readable.held).toEqual(STALE_HELD);
		expect(readable.outboxId).toBe(first.outboxId);
	});

	it('retry after a real reload with the entry unreadable: the same fail-closed held state, then the real state once readable', async () => {
		const { intentId, first, intentBefore } = await heldWrite();
		const failing = failEntryReads(first.outboxId as string);

		const m = await reloadModules();
		try {
			const again = await m.intentRecovery.signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);

			expect(again.outboxId).toBe(first.outboxId);
			expect(again.held).toEqual(STATE_UNCONFIRMED);
			expect(await settledWithin(again.acceptance)).toBe(false);
			expect(signatures).toBe(1);
			expect(entryKeys()).toEqual([first.outboxId]);
			expect(sent).toEqual([]);
			expect(intentStore.map.get(intentId)).toBe(intentBefore);

			failing.value = false;
			const readable = await m.intentRecovery.signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);
			expect(readable.held).toEqual(STALE_HELD);
		} finally {
			await settleLoop(m.outbox);
			m.outbox._setLeaderForTests(null);
		}
	});

	it('a released write whose entry becomes unreadable is not reported unheld until it is read again', async () => {
		const { intentId, first } = await heldWrite();
		const m = await reloadModules();
		try {
			await m.coordinator.confirmScope(EDIT.scope);
			await m.outbox.drainOutbox(MY_HASH, async (mutations) => { sent.push(mutations); }, undefined, undefined, m.ingest.rediscoverDependencies);
			const failing = failEntryReads(first.outboxId as string);

			const unreadable = await m.intentRecovery.signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);
			expect(unreadable.held).toEqual(STATE_UNCONFIRMED);

			failing.value = false;
			const readable = await m.intentRecovery.signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);
			expect(readable).not.toHaveProperty('held');
			expect(signatures).toBe(1);
			expect(sent).toHaveLength(1);
		} finally {
			await settleLoop(m.outbox);
			m.outbox._setLeaderForTests(null);
		}
	});

	it('an entry at the linked id written by another account is never taken as this intent\'s clear write', async () => {
		const { intentId, first } = await heldWrite();
		const id = first.outboxId as string;
		const entry = JSON.parse(outboxStore.map.get(id) as string);
		delete entry.discoveryBlocked;
		outboxStore.map.set(id, JSON.stringify({ ...entry, userHash: 'u_' + 'b'.repeat(128), dependsOnDurableMarkers: true }));

		const again = await signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY);

		expect(again.held).toEqual(STATE_UNCONFIRMED);
		expect(signatures).toBe(1);
		expect(sent).toEqual([]);
	});

	it('a claimed intent whose stored write vanishes between listing and reading is not re-dispatched as a second snapshot', async () => {
		const { intentId, first } = await heldWrite();
		const id = first.outboxId as string;
		const signedMutation = JSON.parse(outboxStore.map.get(id) as string).mutations[0];
		const record = JSON.parse(intentStore.map.get(intentId) as string);
		intentStore.map.set(intentId, JSON.stringify({ ...record, intent: { ...EDIT.readyRow, signedMutation } }));
		const intentBefore = intentStore.map.get(intentId);
		const realKeys = outboxStore.keys.bind(outboxStore);
		let vanishNext = true;
		outboxStore.keys = async () => {
			const listed = await realKeys();
			if (vanishNext && listed.includes(id)) {
				vanishNext = false;
				outboxStore.map.delete(id);
			}
			return listed;
		};

		await expect(signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY)).rejects.toThrow(/cannot be read/);

		expect(signatures).toBe(1);
		expect(entryKeys()).toEqual([]);
		expect(sent).toEqual([]);
		expect(intentStore.map.get(intentId)).toBe(intentBefore);
	});

	it('a claimed intent whose stored write cannot be read is not re-dispatched as a second snapshot', async () => {
		const { intentId, first } = await heldWrite();
		const id = first.outboxId as string;
		const signedMutation = JSON.parse(outboxStore.map.get(id) as string).mutations[0];
		const record = JSON.parse(intentStore.map.get(intentId) as string);
		intentStore.map.set(intentId, JSON.stringify({ ...record, intent: { ...EDIT.readyRow, signedMutation } }));
		failEntryReads(id);

		await expect(signAndDispatchIntent(intentId, EDIT.readyRow as never, SKEY)).rejects.toThrow(/cannot be read/);

		expect(signatures).toBe(1);
		expect(entryKeys()).toEqual([id]);
		expect(sent).toEqual([]);
	});
});
