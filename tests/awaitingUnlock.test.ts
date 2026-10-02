import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const USER = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const DIALOG = 'di_' + '1'.repeat(128);
const SKEY = new Uint8Array(32).fill(3);

const counts = { signatures: 0, http: 0 };
const signed: Array<Record<string, unknown>> = [];

vi.mock('@/api/client', () => {
	const row = (type: string, r: Record<string, unknown>, relation: string) => {
		counts.signatures++;
		signed.push(r);
		const withSig = { ...r, sign_b64: `sig${counts.signatures}`, sign_hash: `hash${counts.signatures}` };
		return { type, ...(type === 'insert' ? { modified: withSig } : { original: {}, changes: withSig }), syncMetadata: { relation } };
	};
	return {
		api: {
			createGenericMutation: (relation: string, r: Record<string, unknown>, _k: unknown, type: string) => row(type, r, relation),
			createStorageMutation: (user_hash: string, uuid: string, value_b64: string, _h: unknown, _v: unknown, owner_timestamp: number, _k: unknown, _i: unknown, deleted_flag: boolean, parent_sign_hash: string | null, _a: unknown, _b: unknown, type: string) =>
				row(type, { user_hash, uuid, value_b64, owner_timestamp, deleted_flag, parent_sign_hash }, 'user_storage'),
			createUserCard: (name: string, keys: { user_hash: string }, type: string, owner_timestamp: number) =>
				({ mutation: row(type, { user_hash: keys.user_hash, name, owner_timestamp, deleted_flag: false }, 'user_cards') }),
			ingestWithAuthEach: async (mutations: unknown[]) => {
				counts.http++;
				return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 1 })) }) } as unknown as Response;
			},
		},
	};
});

vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => ({ async preload() {}, get: () => undefined }),
}));

const { recoverIntents, signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const intents = await import('@/lib/data/intents');
const outbox = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { materializeStorageIntent } = await import('@/lib/data/storageIntent');
const { VaultLockedError, AccountMismatchError } = await import('@/lib/data/keyCustody');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failGet: null as null | ((k: string) => Error | null),
		failSet: null as null | ((k: string, v: string) => boolean),
		async get(k: string) { const e = this.failGet?.(k); if (e) throw e; return map.get(k) ?? null; },
		async set(k: string, v: string) { if (this.failSet?.(k, v)) throw new Error('storage down'); map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

let intentStore: ReturnType<typeof makeStorage>;
let outboxStore: ReturnType<typeof makeStorage>;
let acceptedStore: ReturnType<typeof makeStorage>;
let locked: boolean;
const signingKey = async () => {
	if (locked) throw new VaultLockedError('the vault is locked');
	return SKEY;
};

const scope = { [`dmsg_${'p'.repeat(8)}`]: 'dms_parent', [`dmsg_${'q'.repeat(8)}`]: 'dms_other' };
const messagePayload = (kind: 'message' | 'checkpoint', id: string) => ({
	kind, relation: 'dialog_messages', peerHash: OTHER, dialogHash: DIALOG, messageId: id, ownerHash: USER,
	ownerTimestamp: 1_700_000_000, parts: [{ kind: 'text', text: 'hello' }], observedTails: { ...scope },
});
const materialized: unknown[] = [];
const materializeMessage = async (payload: ReturnType<typeof messagePayload>) => {
	if (locked) throw new VaultLockedError('vault keys are not available');
	materialized.push(structuredClone(payload));
	return {
		kind: 'ready-row' as const, relation: 'dialog_messages', mutationType: 'insert',
		row: { message_id: payload.messageId, sender_hash: payload.ownerHash, dialog_hash: payload.dialogHash, owner_timestamp: payload.ownerTimestamp, refs: JSON.stringify(payload.observedTails) },
	};
};
const storagePayload = () => ({ kind: 'storage', relation: 'user_storage', userHash: USER, uuid: SLOT, valueB64: 'v1', deletedFlag: false, revision: 0 });
const cardIntent = () => ({
	kind: 'ready-row', relation: 'user_cards', mutationType: 'update',
	row: { user_hash: USER, name: 'Me', owner_timestamp: 1_700_000_500, sign_pkey: 'c2lnbg==', contact_pkey: 'Y29udGFjdA==', contact_cert: 'Y2VydA==', crypt_pkey: 'Y3J5cHQ=', crypt_cert: 'Y2VydA==' },
});

const recover = () => recoverIntents(USER, signingKey, { materializeMessage: materializeMessage as never, materializeStorage: materializeStorageIntent });
const record = (id: string) => JSON.parse(intentStore.map.get(id)!);
const outboxEntries = () => [...outboxStore.map.keys()].filter((k) => !k.includes('|'));
const nothingDone = () => {
	expect(counts.signatures).toBe(0);
	expect(outboxEntries()).toEqual([]);
	expect(counts.http).toBe(0);
};

beforeEach(async () => {
	counts.signatures = 0;
	counts.http = 0;
	signed.length = 0;
	materialized.length = 0;
	locked = true;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	intentStore = makeStorage();
	outboxStore = makeStorage();
	acceptedStore = makeStorage();
	intents._setIntentStorageForTests(intentStore);
	outbox._setStorageForTests(outboxStore);
	_setAcceptedSnapshotStorageForTests(acceptedStore);
	_setOwnObservedTailsStorageForTests(makeStorage());
	outbox.startLeaderElection(USER, () => {});
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
});

afterEach(async () => {
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

describe('a locked pass records AWAITING_UNLOCK and does nothing else', () => {
	it.each([
		['message', () => messagePayload('message', 'dmsg_m1'), 'dialog_messages'],
		['checkpoint', () => messagePayload('checkpoint', 'dmsg_c1'), 'dialog_messages'],
		['user_storage', storagePayload, 'user_storage'],
		['user_cards', cardIntent, 'user_cards'],
	] as const)('%s: the same intent, untouched, waiting; 0 signatures, 0 outbox entries, 0 HTTP', async (_kind, payload, relation) => {
		const id = (await intents.enqueueIntent(payload(), USER, relation))!;
		const before = record(id);

		await recover();

		const after = record(id);
		expect(after.awaiting).toMatchObject({ phase: 'AWAITING_UNLOCK', since: expect.any(Number) });
		const { awaiting: _awaiting, ...unchanged } = after;
		expect(unchanged).toEqual(before);
		nothingDone();
	});

	it('user_storage whose accepted base is locked waits too, though its signing key is open', async () => {
		locked = false;
		acceptedStore.failGet = () => new VaultLockedError('local storage is not readable yet');
		const id = (await intents.enqueueIntent(storagePayload(), USER, 'user_storage'))!;
		await recover();
		expect(record(id).awaiting).toMatchObject({ phase: 'AWAITING_UNLOCK' });
		nothingDone();
	});

	it('another locked pass writes nothing: the same id, payload and wait; no new intent, no retry state anywhere', async () => {
		const id = (await intents.enqueueIntent(messagePayload('message', 'dmsg_m1'), USER, 'dialog_messages'))!;
		await recover();
		const first = intentStore.map.get(id);
		const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
		try {
			await recover();
			await recover();
		} finally {
			later.mockRestore();
		}

		expect(intentStore.map.get(id)).toBe(first);
		expect([...intentStore.map.keys()].filter((k) => !k.startsWith('owner|'))).toEqual([id]);
		expect(first).not.toMatch(/attempts|nextAttemptAt/);
		nothingDone();
	});

	it('no timestamp is reserved while locked: the card clock and the storage payload stay as they were', async () => {
		const clockKey = `clock|user_cards|${USER}`;
		await outbox.writeCardClock(USER, 1_700_000_500);
		const clockBefore = outboxStore.map.get(clockKey);
		const card = (await intents.enqueueIntent(cardIntent(), USER, 'user_cards'))!;
		const storage = (await intents.enqueueIntent(storagePayload(), USER, 'user_storage'))!;

		await recover();
		await recover();

		expect(outboxStore.map.get(clockKey)).toBe(clockBefore);
		expect(record(card).intent.row.owner_timestamp).toBe(1_700_000_500);
		expect(record(storage).intent).toEqual(storagePayload());
		nothingDone();
	});
});

describe('after the unlock, the same intent goes on — once', () => {
	it.each([
		['message', 'dmsg_m1'],
		['checkpoint', 'dmsg_c1'],
	] as const)('%s: signed and stored once, from its captured scope, unchanged', async (kind, messageId) => {
		const payload = messagePayload(kind, messageId);
		const id = (await intents.enqueueIntent(payload, USER, 'dialog_messages'))!;
		await recover();
		expect(record(id).awaiting).toBeDefined();

		locked = false;
		await recover();
		await recover();

		expect(counts.signatures).toBe(1);
		expect(materialized).toEqual([payload]);
		expect(JSON.parse(String(signed[0].refs))).toEqual(scope);
		expect(outboxEntries()).toHaveLength(1);
		expect(record(id).intent).toMatchObject({ resolved: true });
		expect(record(id).awaiting).toBeUndefined();
		await vi.waitFor(() => expect(counts.http).toBe(1));
	});

	it.each([
		['user_storage', storagePayload, 'user_storage'],
		['user_cards', cardIntent, 'user_cards'],
	] as const)('%s: signed and stored once', async (_kind, payload, relation) => {
		const id = (await intents.enqueueIntent(payload(), USER, relation))!;
		await recover();
		locked = false;
		await recover();
		await recover();

		expect(counts.signatures).toBe(1);
		expect(outboxEntries()).toHaveLength(1);
		expect(record(id).intent).toMatchObject({ resolved: true });
		if (relation === 'user_cards') expect(signed[0].owner_timestamp).toBe(1_700_000_500);
	});

	it('the wait cannot be left without its durable write: nothing is signed then, and it keeps waiting', async () => {
		const id = (await intents.enqueueIntent(messagePayload('message', 'dmsg_m1'), USER, 'dialog_messages'))!;
		await recover();
		locked = false;
		intentStore.failSet = (k) => k === id;
		await recover();

		expect(record(id).awaiting).toMatchObject({ phase: 'AWAITING_UNLOCK' });
		nothingDone();
	});
});

describe('the account is part of the wait', () => {
	it('AccountMismatchError is no wait: the intent is left exactly as it was, and nothing is signed', async () => {
		const id = (await intents.enqueueIntent(messagePayload('message', 'dmsg_m1'), USER, 'dialog_messages'))!;
		const before = intentStore.map.get(id);
		await recoverIntents(USER, async () => { throw new AccountMismatchError('another account is open'); }, { materializeMessage: materializeMessage as never });

		expect(intentStore.map.get(id)).toBe(before);
		nothingDone();
		expect(await intents.markIntentAwaitingUnlock(id, OTHER)).toBe(false); // nor can another account record it
	});

	it('a sign-out or account switch between the lock and the unlock: the old account\'s intent does not go on', async () => {
		const id = (await intents.enqueueIntent(messagePayload('message', 'dmsg_m1'), USER, 'dialog_messages'))!;
		await recover();
		const waiting = intentStore.map.get(id);

		outbox.stopLeaderElection();
		outbox.startLeaderElection(OTHER, () => {});
		locked = false;
		await recover();
		await recoverIntents(OTHER, signingKey, { materializeMessage: materializeMessage as never });

		expect(intentStore.map.get(id)).toBe(waiting);
		nothingDone();
	});

	it('the session is checked again right before signing', async () => {
		const id = (await intents.enqueueIntent(cardIntent(), USER, 'user_cards'))!;
		const token = outbox.currentSessionToken()!;
		outbox.stopLeaderElection();
		outbox.startLeaderElection(OTHER, () => {});

		await expect(signAndDispatchIntent(id, cardIntent() as never, SKEY, { token })).rejects.toBeInstanceOf(outbox.SessionFencedError);
		expect(record(id).intent).not.toHaveProperty('signedMutation');
		nothingDone();
	});
});

describe('failures around the wait', () => {
	it('a wait that cannot be stored leaves the intent as it was, and nothing is signed or sent', async () => {
		const id = (await intents.enqueueIntent(messagePayload('message', 'dmsg_m1'), USER, 'dialog_messages'))!;
		const before = intentStore.map.get(id);
		intentStore.failSet = (k) => k === id;
		await recover();

		expect(intentStore.map.get(id)).toBe(before);
		nothingDone();
	});

	it('one intent waiting does not hold up another whose keys are open', async () => {
		locked = false;
		const lockedMessage = (await intents.enqueueIntent(messagePayload('message', 'dmsg_locked'), USER, 'dialog_messages'))!;
		const other = (await intents.enqueueIntent({
			kind: 'ready-row', relation: 'dialog_message_receipts', mutationType: 'insert',
			row: { receipt_hash: 'dmrc_1', peer_hash: USER, dialog_hash: DIALOG },
		}, USER, 'dialog_message_receipts'))!;
		const lockedForOne = async (p: ReturnType<typeof messagePayload>) => {
			if (p.messageId === 'dmsg_locked') throw new VaultLockedError('this key is locked');
			return materializeMessage(p);
		};
		await recoverIntents(USER, signingKey, { materializeMessage: lockedForOne as never });

		expect(record(lockedMessage).awaiting).toMatchObject({ phase: 'AWAITING_UNLOCK' });
		expect(record(other).intent).toMatchObject({ resolved: true });
		expect(counts.signatures).toBe(1);
		await vi.waitFor(() => expect(counts.http).toBe(1));
	});
});
