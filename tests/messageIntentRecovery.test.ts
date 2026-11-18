import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMemoryLocalStore, markDialogKeyPublishedHere } from './helpers/dialogKeyPublished';
import { decodeContent } from '@buckitup/pq-client/content';
import {
	startLeaderElection, stopLeaderElection, currentSessionToken, SessionFencedError,
	enqueue as outboxEnqueue, _setStorageForTests as _setOutboxStorageForTests,
} from '@/lib/data/outbox';
import { makeTestIdentity, signedDialogKeyRow } from './helpers/signedFixtures';

let sendImpl: (mutations: unknown[]) => Promise<unknown>;
const sentMutations: Array<{ relation: string; row: Record<string, unknown>; type: string }> = [];

const DIALOG_HASH = 'di_' + '1'.repeat(128);
const ME = makeTestIdentity(1, 'me');
const PEER = makeTestIdentity(3, 'peer');
const MY_HASH = ME.userHash;
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const PEER_HASH = PEER.userHash;
const SKEY = new Uint8Array(32).fill(9);

const decodeRefs = (refsMapB64: string) => JSON.parse(refsMapB64.replace(/^enc\(/, '').replace(/\)$/, ''));
const decodeMessageContent = (contentB64: string) => decodeContent(contentB64.replace(/^enc\(/, '').replace(/\)$/, ''));

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections: { cards: ReturnType<typeof makeCollection>; dialog: { keys: ReturnType<typeof makeCollection>; reactions?: ReturnType<typeof makeCollection>; messages?: ReturnType<typeof makeCollection> } };

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

let signCount = 0;
vi.mock('@/api/client', () => ({ api: {} }));

vi.mock('@buckitup/pq-client/rows', async (importOriginal) => ({
	...(await importOriginal<typeof import('@buckitup/pq-client/rows')>()),
	signRow: (_relation: string, row: Record<string, unknown>) => row,
	rowMutation: (relation: string, row: Record<string, unknown>, type: string) => {
		signCount++;
		const signed = { ...row, sign_hash: `sig_${signCount}` };
		return type === 'insert'
			? { type, relation, row, modified: signed, syncMetadata: { relation } }
			: { type, relation, row, original: {}, changes: signed, syncMetadata: { relation } };
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
		if (crashBeforeOutbox > 0) {
			crashBeforeOutbox--;
			throw new Error('crash before the outbox write');
		}
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
let crashBeforeOutbox = 0;
const encryptGate: Array<{ reached: () => void; release: Promise<void> }> = [];
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => {
				if (vaultLocked) throw new Error('vault is locked');
				return ME.vault;
			},
		}),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@buckitup/pq-client/dialogs', async (importOriginal) => ({
	...(await importOriginal<typeof import('@buckitup/pq-client/dialogs')>()),
	deriveSenderMsgKey: () => new Uint8Array(32),
	wrapSenderMsgKey: async () => ({ peer_kem_wrap_key_b64: 'wrap', peer_wrapped_msg_key_b64: 'wrapped' }),
	encryptContent: async (_key: unknown, text: string) => {
		const gate = encryptGate.shift();
		if (gate) { gate.reached(); await gate.release; }
		return `enc(${text})`;
	},
	reactionHash: (_key: unknown, messageId: string, reactor: string, emoji: string) => `dmr_${Buffer.from(messageId + reactor + emoji).toString('hex').slice(0, 128).padEnd(128, '0')}`,
}));

const { recoverIntents, signAndDispatchIntent, withIntentEntityLock, handOverEarlierOfEntity } = await import('@/lib/data/intentRecovery');
const { VaultLockedError } = await import('@/lib/data/keyCustody');
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
	messageId: 'dmsg_01920000-0000-7000-8000-000000000008',
	ownerHash: MY_HASH,
	ownerTimestamp: 1000,
	parts: [{ kind: 'text' as const, text: 'hello' }],
	observedTails: { 'dmsg_0192eeee-0000-7000-8000-000000000001': 'dms_' + 'e'.repeat(128) },
	...overrides,
});

beforeEach(async () => {
	await useMemoryLocalStore();
	await markDialogKeyPublishedHere(MY_HASH, DIALOG_HASH);
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
		cards: makeCollection({ [MY_HASH]: ME.card, [PEER_HASH]: PEER.card }),
		dialog: {
			keys: makeCollection({
				[`${DIALOG_HASH}|${MY_HASH}`]: signedDialogKeyRow(ME, { dialog_hash: DIALOG_HASH, peer_hash: PEER_HASH }),
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
		const payload = messagePayload({ kind: 'checkpoint', messageId: 'dmsg_01920000-0000-7000-8000-000000000002', parts: [part], observedTails: {} });
		await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(decodeMessageContent(sentMutations[0].row.content_b64 as string)).toEqual([part]);
	});

	it('does not touch a message intent belonging to a different account', async () => {
		await enqueueIntent(messagePayload({ messageId: 'dmsg_01920000-0000-7000-8000-000000000006' }), MY_HASH, 'dialog_messages');
		await enqueueIntent(messagePayload({ ownerHash: OTHER_HASH, messageId: 'dmsg_01920000-0000-7000-8000-000000000009' }), OTHER_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(sentMutations[0].row.message_id).toBe('dmsg_01920000-0000-7000-8000-000000000006');
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

describe('two dispatch paths and one entity', () => {
	const reaction = (messageSignHash: string, desiredActive: boolean) => ({
		kind: 'reaction' as const,
		relation: 'dialog_message_reactions' as const,
		peerHash: PEER_HASH,
		dialogHash: DIALOG_HASH,
		messageId: 'dmsg_01920000-0000-7000-8000-0000000000bb',
		messageSignHash,
		emoji: '👍',
		desiredActive,
		ownerHash: MY_HASH,
	});

	it('recovery and the store\'s dispatch build intents of one reaction one after the other, each on the base the previous left', async () => {
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		collections.dialog.reactions = makeCollection();
		const tipHash = 'dms_' + 'a'.repeat(128);
		const editedHash = 'dms_' + 'b'.repeat(128);
		const first = reaction(tipHash, true);
		const firstId = await enqueueIntent(first, MY_HASH, 'dialog_message_reactions');

		let reached!: () => void;
		const atGate = new Promise<void>((r) => (reached = r));
		let release!: () => void;
		encryptGate.push({ reached, release: new Promise<void>((r) => (release = r)) });

		const recovery = recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		await atGate;

		const second = reaction(editedHash, true);
		const secondId = await enqueueIntent(second, MY_HASH, 'dialog_message_reactions');
		const token = currentSessionToken()!;
		const storeDispatch = withIntentEntityLock(second, async () => {
			const readyRow = await materializeMessageIntent(second, token);
			return readyRow && signAndDispatchIntent(secondId!, readyRow, SKEY, { token });
		});
		await new Promise((r) => setTimeout(r, 20));
		release();
		await recovery;
		await storeDispatch;

		const reactions = sentMutations.filter((m) => m.relation === 'dialog_message_reactions');
		expect(reactions.map((m) => [m.type, m.row.message_sign_hash])).toEqual([['insert', tipHash], ['update', editedHash]]);
		expect(Number(reactions[1].row.owner_timestamp)).toBeGreaterThan(Number(reactions[0].row.owner_timestamp));
		expect(firstId).not.toBe(secondId);
	});

	it('another entity is not held up while one entity is being built', async () => {
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		collections.dialog.reactions = makeCollection();
		const token = currentSessionToken()!;
		const slow = reaction('dms_' + 'a'.repeat(128), true);
		const other = { ...reaction('dms_' + 'a'.repeat(128), true), emoji: '🎉' };
		const slowId = await enqueueIntent(slow, MY_HASH, 'dialog_message_reactions');
		const otherId = await enqueueIntent(other, MY_HASH, 'dialog_message_reactions');

		let reached!: () => void;
		const atGate = new Promise<void>((r) => (reached = r));
		let release!: () => void;
		encryptGate.push({ reached, release: new Promise<void>((r) => (release = r)) });
		const held = withIntentEntityLock(slow, async () => {
			const row = await materializeMessageIntent(slow, token);
			return row && signAndDispatchIntent(slowId!, row, SKEY, { token });
		});
		await atGate;
		await withIntentEntityLock(other, async () => {
			const row = await materializeMessageIntent(other, token);
			return row && signAndDispatchIntent(otherId!, row, SKEY, { token });
		});
		expect(sentMutations.filter((m) => m.relation === 'dialog_message_reactions')).toHaveLength(1);
		release();
		await held;
		expect(sentMutations.filter((m) => m.relation === 'dialog_message_reactions')).toHaveLength(2);
	});

	it('a later intent sent first hands the earlier one over before itself, and recovery sends neither again', async () => {
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		collections.dialog.reactions = makeCollection();
		const token = currentSessionToken()!;
		const tipHash = 'dms_' + 'c'.repeat(128);
		const editedHash = 'dms_' + 'd'.repeat(128);
		const earlier = reaction(tipHash, true);
		const later = reaction(editedHash, true);
		const earlierId = await enqueueIntent(earlier, MY_HASH, 'dialog_message_reactions');
		const laterId = await enqueueIntent(later, MY_HASH, 'dialog_message_reactions');

		await withIntentEntityLock(later, async () => {
			await handOverEarlierOfEntity(laterId!, later, token, SKEY, materializeMessageIntent);
			const row = await materializeMessageIntent(later, token);
			return row && signAndDispatchIntent(laterId!, row, SKEY, { token });
		});
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		const reactions = sentMutations.filter((m) => m.relation === 'dialog_message_reactions');
		expect(reactions.map((m) => [m.type, m.row.message_sign_hash])).toEqual([['insert', tipHash], ['update', editedHash]]);
		for (const id of [earlierId, laterId]) expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true });
	});
});

describe('a signed intent that never reached the outbox', () => {
	const reaction = (messageSignHash: string) => ({
		kind: 'reaction' as const,
		relation: 'dialog_message_reactions' as const,
		peerHash: PEER_HASH,
		dialogHash: DIALOG_HASH,
		messageId: 'dmsg_01920000-0000-7000-8000-0000000000cc',
		messageSignHash,
		emoji: '👍',
		desiredActive: true,
		ownerHash: MY_HASH,
	});
	const tipHash = 'dms_' + 'e'.repeat(128);
	const editedHash = 'dms_' + 'f'.repeat(128);

	const signedButNotSent = async () => {
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		collections.dialog.reactions = makeCollection();
		const token = currentSessionToken()!;
		const earlier = reaction(tipHash);
		const earlierId = (await enqueueIntent(earlier, MY_HASH, 'dialog_message_reactions'))!;
		crashBeforeOutbox = 1;
		await expect(withIntentEntityLock(earlier, async () => {
			const row = await materializeMessageIntent(earlier, token);
			return row && signAndDispatchIntent(earlierId, row, SKEY, { token });
		})).rejects.toThrow(/crash/);
		const stored = (await getIntent(earlierId))!.intent as { signedMutation?: { changes?: Record<string, unknown>; modified?: Record<string, unknown> }; resolved?: boolean };
		expect(stored.signedMutation).toBeTruthy();
		expect(stored.resolved).not.toBe(true);
		expect(sentMutations).toHaveLength(0);
		const signedHash = (stored.signedMutation!.modified ?? stored.signedMutation!.changes)!.sign_hash;
		const later = reaction(editedHash);
		const laterId = (await enqueueIntent(later, MY_HASH, 'dialog_message_reactions'))!;
		const storePath = () => withIntentEntityLock(later, async () => {
			await handOverEarlierOfEntity(laterId, later, token, SKEY, materializeMessageIntent);
			const row = await materializeMessageIntent(later, token);
			return row && signAndDispatchIntent(laterId, row, SKEY, { token });
		});
		return { earlierId, laterId, signedHash, storePath, signsBefore: signCount };
	};

	const expectOrdered = async (earlierId: string, laterId: string, signedHash: unknown, signsBefore: number) => {
		const reactions = sentMutations.filter((m) => m.relation === 'dialog_message_reactions');
		expect(reactions.map((m) => [m.type, m.row.message_sign_hash])).toEqual([['insert', tipHash], ['update', editedHash]]);
		expect(((reactions[0] as unknown as { modified: Record<string, unknown> }).modified).sign_hash).toBe(signedHash);
		expect(signCount).toBe(signsBefore + 1);
		expect(Number(reactions[1].row.owner_timestamp)).toBeGreaterThan(Number(reactions[0].row.owner_timestamp));
		for (const id of [earlierId, laterId]) {
			const entry = (await getIntent(id))!.intent as { resolved?: boolean; ref?: unknown };
			expect(entry).toMatchObject({ resolved: true });
			expect(typeof entry.ref).toBe('string');
		}
	};

	it('after a reload, a later intent started first by the store sends the stored signature of the earlier one before itself', async () => {
		const { earlierId, laterId, signedHash, storePath, signsBefore } = await signedButNotSent();
		await storePath();
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		await expectOrdered(earlierId, laterId, signedHash, signsBefore);
	});

	it('after a reload, recovery of the earlier and the store\'s later intent running at once still go in that order, once each', async () => {
		const { earlierId, laterId, signedHash, storePath, signsBefore } = await signedButNotSent();
		await Promise.all([recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent }), storePath()]);
		await expectOrdered(earlierId, laterId, signedHash, signsBefore);
	});
});

describe('an old own dialog_keys row whose publish mark cannot be read', () => {
	const MARK = `dialog-key-published-here:${MY_HASH}|${DIALOG_HASH}`;
	const storeFailing = async (failure: () => Error | null) => {
		const map = new Map<string, string>();
		(await import('@/lib/data/localStore'))._setStoreForTests({
			get: async (k) => { const e = failure(); if (e) throw e; return map.get(k) ?? null; },
			set: async (k, v) => { map.set(k, v); },
			delete: async (k) => { map.delete(k); },
			keys: async () => [...map.keys()],
			clear: async () => { map.clear(); },
		});
		return map;
	};

	it.each([
		['the account is locked', () => new VaultLockedError('locked'), 'AWAITING_UNLOCK'],
		['the store fails', () => new Error('disk unavailable'), null],
	] as const)('when %s, nothing is sent; once it reads again the key is republished, then the message goes', async (_name, fail, awaitingPhase) => {
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		let broken = true;
		const map = await storeFailing(() => (broken ? fail() : null));
		const payload = messagePayload({ messageId: 'dmsg_01920000-0000-7000-8000-0000000000aa' });
		const id = await enqueueIntent(payload, MY_HASH, 'dialog_messages');

		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		expect(sentMutations).toHaveLength(0);
		const waiting = await getIntent(id!) as { resolved?: boolean; awaiting?: { phase?: string } } | null;
		expect(waiting?.resolved).not.toBe(true);
		if (awaitingPhase) expect(waiting?.awaiting).toMatchObject({ phase: awaitingPhase });
		expect(map.has(MARK)).toBe(false);

		broken = false;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });
		expect(sentMutations.map((m) => [m.relation, m.type])).toEqual([['dialog_keys', 'update'], ['dialog_messages', 'insert']]);
		expect(Number(sentMutations[0].row.owner_timestamp)).toBeGreaterThan(1_700_000_000);
		expect(sentMutations[1].row.message_id).toBe(payload.messageId);
		expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true, outcome: 'durably-dispatched' });
		expect(map.get(MARK)).toBe('true');
	});
});

describe('recoverIntents: locked vault at recovery time (§5)', () => {
	it('a locked vault leaves the intent exactly as captured — no signature, no mutation, no identity change; unlock resumes and finishes it', async () => {
		const payload = messagePayload({ messageId: 'dmsg_01920000-0000-7000-8000-000000000005' });
		const id = await enqueueIntent(payload, MY_HASH, 'dialog_messages');
		const beforeUnlock = await getIntent(id!);

		vaultLocked = true;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(0);
		expect(signCount).toBe(0);
		const stillLocked = await getIntent(id!);
		const { awaiting, ...unchanged } = stillLocked as typeof stillLocked & { awaiting?: unknown };
		expect(unchanged).toEqual(beforeUnlock);
		expect(awaiting).toMatchObject({ phase: 'AWAITING_UNLOCK' });

		vaultLocked = false;
		await recoverIntents(MY_HASH, SKEY, { materializeMessage: materializeMessageIntent });

		expect(sentMutations).toHaveLength(1);
		expect(sentMutations[0].row.message_id).toBe('dmsg_01920000-0000-7000-8000-000000000005');
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
		const payload = messagePayload({ messageId: 'dmsg_01920000-0000-7000-8000-000000000003' });
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
		const payload = messagePayload({ ownerHash: MY_HASH, messageId: 'dmsg_01920000-0000-7000-8000-000000000004', ownerTimestamp: 42 });

		const readyRow = await materializeMessageIntent(payload, currentSessionToken()!);

		expect(readyRow).not.toBeNull();
		expect(readyRow!.relation).toBe('dialog_messages');
		expect(readyRow!.row.sender_hash).toBe(MY_HASH);
		expect(readyRow!.row.message_id).toBe('dmsg_01920000-0000-7000-8000-000000000004');
		expect(readyRow!.row.owner_timestamp).toBe(42);
	});

	it('refuses internally when the token\'s account does not match payload.ownerHash — never trusts the caller alone', async () => {
		const payload = messagePayload({ ownerHash: OTHER_HASH, messageId: 'dmsg_01920000-0000-7000-8000-000000000007' });

		await expect(materializeMessageIntent(payload, currentSessionToken()!)).rejects.toThrow(SessionFencedError);
	});
	// A profile photo's file sits inside its avatar part; the message must
	// still wait for that file's manifest like any attachment's.
	it('names the file of a profile photo as a dependency of the message', async () => {
		const photo = {
			kind: 'image' as const, widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: 'avatar.jpg', size: 1,
			mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + '5'.repeat(32), encSecretB64: 'k',
		};
		const payload = messagePayload({
			messageId: 'dmsg_01920000-0000-7000-8000-000000000001',
			parts: [{ kind: 'avatar' as const, avatarId: 'a'.repeat(32), photo }, { kind: 'avatar_removed' as const, avatarId: 'b'.repeat(32) }],
		});
		const readyRow = await materializeMessageIntent(payload as never, currentSessionToken()!);
		expect(readyRow!.fileIds).toEqual([photo.fileId]);
	});
});
