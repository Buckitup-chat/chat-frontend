import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeContent } from '@/lib/pq/content';
import {
	startLeaderElection, stopLeaderElection, currentSessionToken, SessionFencedError,
	enqueue as outboxEnqueue, _setStorageForTests as _setOutboxStorageForTests,
} from '@/lib/data/outbox';

let sendImpl: (mutations: unknown[]) => Promise<unknown>;
const sentMutations: Array<{ relation: string; row: Record<string, unknown>; type: string }> = [];

const DIALOG_HASH = 'di_' + '1'.repeat(128);
const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const PEER_HASH = 'u_' + 'c'.repeat(128);
const SKEY = new Uint8Array(32).fill(9);

const decodeRefs = (refsMapB64: string) => JSON.parse(refsMapB64.replace(/^enc\(/, '').replace(/\)$/, ''));
const decodeMessageContent = (contentB64: string) => decodeContent(contentB64.replace(/^enc\(/, '').replace(/\)$/, ''));

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections: { cards: ReturnType<typeof makeCollection>; dialog: { keys: ReturnType<typeof makeCollection> } };

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

let signCount = 0;
vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			signCount++;
			return { type, relation, row, changes: { ...row, sign_hash: `sig_${signCount}` }, syncMetadata: { relation } };
		},
	},
}));

const { MockDurabilityError } = vi.hoisted(() => {
	class MockDurabilityError extends Error {}
	return { MockDurabilityError };
});
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (
		mutations: Array<{ relation: string; row: Record<string, unknown>; type: string }>,
		_signSkey: unknown,
		opts: { onDurable?: (outboxId: string) => void | Promise<void>; sourceIntentId?: string } = {}
	) => {
		sentMutations.push(...mutations);
		const owner = (mutations[0]?.row?.sender_hash as string | undefined) ?? MY_HASH;
		const outboxId = (await outboxEnqueue(mutations, owner, { sourceIntentId: opts.sourceIntentId }))!;
		await opts.onDurable?.(outboxId);
		const result = await sendImpl(mutations);
		return { outboxId, phase: 'accepted', result, acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
	DurabilityError: MockDurabilityError,
}));

let vaultLocked = false;
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => {
				if (vaultLocked) throw new Error('vault is locked');
				return { sign_skey: 'AAAA', crypt_skey: 'BBBB', evm_skey: 'cc' };
			},
		}),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
		encryptContent: async (_key: unknown, text: string) => `enc(${text})`,
	},
}));

const { recoverIntents, signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const { materializeMessageIntent } = await import('@/lib/data/messageIntent');
const { enqueueIntent, getIntent, intentsOf, _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');

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

const messagePayload = (overrides: Record<string, unknown> = {}) => ({
	kind: 'message' as const,
	relation: 'dialog_messages' as const,
	peerHash: PEER_HASH,
	dialogHash: DIALOG_HASH,
	messageId: 'dmsg_recovered',
	ownerHash: MY_HASH,
	ownerTimestamp: 1000,
	parts: [{ kind: 'text' as const, text: 'hello' }],
	observedTails: { dmsg_prev: 'dms_prevhash' },
	...overrides,
});

beforeEach(async () => {
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setOutboxStorageForTests(makeStorage());
	sentMutations.length = 0;
	signCount = 0;
	vaultLocked = false;
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	sendImpl = async () => ({ txids: [1] });
	collections = {
		cards: makeCollection({ [PEER_HASH]: { user_hash: PEER_HASH, crypt_pkey: 'peer-pkey' } }),
		dialog: {
			keys: makeCollection({
				[`${DIALOG_HASH}|${MY_HASH}`]: { dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false },
			}),
		},
	};
});

describe('recoverIntents: message/checkpoint intents (§C reload recovery)', () => {
	it('materializes and dispatches a durably captured message intent using the exact captured identity and scope', async () => {
		const payload = messagePayload();
		await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		const mutation = sentMutations[0];
		expect(mutation.relation).toBe('dialog_messages');
		expect(mutation.row.message_id).toBe(payload.messageId);
		expect(mutation.row.sender_hash).toBe(payload.ownerHash);
		expect(mutation.row.owner_timestamp).toBe(payload.ownerTimestamp);
		expect(mutation.row.parent_sign_hash).toBeNull();
		expect(decodeRefs(mutation.row.refs_map_b64 as string)).toEqual(payload.observedTails);
		expect(decodeMessageContent(mutation.row.content_b64 as string)).toEqual(payload.parts);
		expect((await intentsOf(MY_HASH)).entries).toEqual([]);
	});

	it('recovers a checkpoint intent the same way, without recomputing its frontier/view commitments', async () => {
		const part = {
			kind: 'checkpoint', version: 2, reducerVersion: 'dialog-state-v1', treeVersion: 'dialog-view-tree-v2',
			frontierRoot: 'dfr_' + '2'.repeat(128), viewRoot: 'dvr_' + '3'.repeat(128),
			frontier: { 'dmsg_0192aaaa-0000-7000-8000-000000000001': 'dms_' + '4'.repeat(128) },
			createdAt: 1_700_000_000,
		};
		const payload = messagePayload({ kind: 'checkpoint', messageId: 'dmsg_checkpoint', parts: [part], observedTails: {} });
		await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(decodeMessageContent(sentMutations[0].row.content_b64 as string)).toEqual([part]);
	});

	it('does not touch a message intent belonging to a different account', async () => {
		await enqueueIntent(messagePayload({ messageId: 'dmsg_mine' }), MY_HASH, 'dialog_messages');
		await enqueueIntent(messagePayload({ ownerHash: OTHER_HASH, messageId: 'dmsg_theirs' }), OTHER_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(sentMutations[0].row.message_id).toBe('dmsg_mine');
		expect((await intentsOf(OTHER_HASH)).entries).toHaveLength(1);
	});

	it('without a registered materializer, a message intent is left durable for a later recovery attempt — not dropped, not retried as a network failure', async () => {
		const payload = messagePayload();
		const id = await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY); // no opts.materializeMessage

		expect(sentMutations).toHaveLength(0);
		expect(await getIntent(id!)).not.toBeNull();
	});

	it('does not re-materialize or re-sign once the outbox already durably has the signed snapshot', async () => {
		await enqueueIntent(messagePayload(), MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		expect(sentMutations).toHaveLength(1);

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		expect(sentMutations).toHaveLength(1); // nothing left to recover
	});
});

describe('recoverIntents: locked vault at recovery time (§5)', () => {
	it('a locked vault leaves the intent exactly as captured — no signature, no mutation, no identity change; unlock resumes and finishes it', async () => {
		const payload = messagePayload({ messageId: 'dmsg_locked' });
		const id = await enqueueIntent(payload, MY_HASH, 'dialog_messages');
		const beforeUnlock = await getIntent(id!);

		vaultLocked = true;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(0);
		expect(signCount).toBe(0);
		const stillLocked = await getIntent(id!);
		expect(stillLocked).toEqual(beforeUnlock);

		vaultLocked = false;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(sentMutations[0].row.message_id).toBe('dmsg_locked');
		expect(sentMutations[0].row.owner_timestamp).toBe(payload.ownerTimestamp);
		expect(decodeRefs(sentMutations[0].row.refs_map_b64 as string)).toEqual(payload.observedTails);
		expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true, outcome: 'durably-dispatched' });
	});
});

describe('signAndDispatchIntent: idempotent unsigned intent -> signed outbox handoff', () => {
	const makeFlakyStorage = () => {
		const map = new Map<string, string>();
		const control = { failDispatchConfirmation: false };
		const storage = {
			async get(k: string) { return map.get(k) ?? null; },
			async set(k: string, v: string) {
				if (control.failDispatchConfirmation && (v.includes('"dispatchConfirmed":true') || v.includes('"resolved":true'))) {
					throw new Error('simulated crash — could not durably confirm/resolve the dispatch');
				}
				map.set(k, v);
			},
			async delete(k: string) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		};
		return { storage, control };
	};

	const readyRow = { kind: 'ready-row' as const, relation: 'dialog_messages', row: { message_id: 'm_claim', sender_hash: MY_HASH }, mutationType: 'insert' as const };

	it('a crash right after the durable outbox handoff (dispatchConfirmed/marker writes never land) never triggers a second HTTP send — the next attempt finishes via the outbox\'s own sourceIntentId link', async () => {
		const { storage, control } = makeFlakyStorage();
		_setIntentStorageForTests(storage);
		const id = (await enqueueIntent(readyRow, MY_HASH, 'dialog_messages'))!;

		control.failDispatchConfirmation = true;
		const first = await signAndDispatchIntent(id, readyRow, SKEY);
		expect(first.phase).toBe('accepted'); // the send itself genuinely succeeded
		expect(signCount).toBe(1);
		expect(sentMutations).toHaveLength(1);

		const afterFirst = await getIntent(id);
		expect(afterFirst).not.toBeNull();
		expect((afterFirst!.intent as Record<string, unknown>).resolved).toBeFalsy();
		expect((afterFirst!.intent as Record<string, unknown>).dispatchConfirmed).toBeFalsy();

		control.failDispatchConfirmation = false;
		const second = await signAndDispatchIntent(id, readyRow, SKEY);
		expect(signCount).toBe(1);
		expect(sentMutations).toHaveLength(1); // no second HTTP send
		expect(second.outboxId).toBeTruthy();

		expect((await getIntent(id))?.intent).toMatchObject({ resolved: true, ref: second.outboxId });
	});

	it('reload recovery: the same crash-then-heal sequence for a message intent — materialization never runs twice, the outbox is never re-sent to', async () => {
		const { storage, control } = makeFlakyStorage();
		_setIntentStorageForTests(storage);
		const payload = messagePayload({ messageId: 'dmsg_claim_recover' });
		await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		const materializeSpy = vi.fn(materializeMessageIntent);
		control.failDispatchConfirmation = true;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeSpy });
		expect(signCount).toBe(1);
		expect(materializeSpy).toHaveBeenCalledTimes(1);
		expect(sentMutations).toHaveLength(1);

		control.failDispatchConfirmation = false;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeSpy });
		expect(signCount).toBe(1);
		expect(materializeSpy).toHaveBeenCalledTimes(1);
		expect(sentMutations).toHaveLength(1);
	});

	it('two tabs recovering the same intent one after another produce one durable signed identity and one durable outbox entry', async () => {
		const { storage, control } = makeFlakyStorage();
		_setIntentStorageForTests(storage);
		const id = (await enqueueIntent(readyRow, MY_HASH, 'dialog_messages'))!;

		control.failDispatchConfirmation = true; // tab 1 signs, dispatches, but its own confirmation writes never land
		await signAndDispatchIntent(id, readyRow, SKEY);

		// Tab 2 independently recovers the same durable intent afterward.
		control.failDispatchConfirmation = false;
		await signAndDispatchIntent(id, readyRow, SKEY);

		expect(signCount).toBe(1);
		expect(sentMutations).toHaveLength(1);
	});

	it('a concurrent live dispatch and recovery pass for the SAME intent id produce exactly one signature', async () => {
		const id = (await enqueueIntent(readyRow, MY_HASH, 'dialog_messages'))!;

		const [a, b] = await Promise.all([
			signAndDispatchIntent(id, readyRow, SKEY),
			signAndDispatchIntent(id, readyRow, SKEY),
		]);

		expect(signCount).toBe(1);
		expect(sentMutations).toHaveLength(1);
		expect(a).toBe(b);
	});
});

describe('materializeMessageIntent: builds the row from the captured payload alone (§E account isolation)', () => {
	it('uses the payload\'s own identity fields, not any ambient/global session state', async () => {
		const payload = messagePayload({ ownerHash: MY_HASH, messageId: 'dmsg_isolated', ownerTimestamp: 42 });

		const readyRow = await materializeMessageIntent(payload, currentSessionToken()!);

		expect(readyRow.relation).toBe('dialog_messages');
		expect(readyRow.row.sender_hash).toBe(MY_HASH);
		expect(readyRow.row.message_id).toBe('dmsg_isolated');
		expect(readyRow.row.owner_timestamp).toBe(42);
	});

	it('refuses internally when the token\'s account does not match payload.ownerHash — never trusts the caller alone', async () => {
		const payload = messagePayload({ ownerHash: OTHER_HASH, messageId: 'dmsg_mismatched' });

		await expect(materializeMessageIntent(payload, currentSessionToken()!)).rejects.toThrow(SessionFencedError);
	});
});
