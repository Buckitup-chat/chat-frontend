import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { SignableFields } from '@/lib/pq/signature';
import { makeTestIdentity, signRow, signedDialogKeyRow } from './helpers/signedFixtures';
import { recordAccepted, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop,
	quarantinedEntries, blockedEntries, blockedDependentIssues, discardEntry,
	startLeaderElection, stopLeaderElection,
} from '@/lib/data/outbox';

const myIdentity = makeTestIdentity(1);
const peerIdentity = makeTestIdentity(2);
const MY_HASH = myIdentity.userHash;
const PEER_HASH = peerIdentity.userHash;
const DIALOG_HASH = 'di_' + '3'.repeat(128);
const MSG_ID = 'dmsg_' + '4'.repeat(128);
const EMOJI = '\u{1F44D}';
const REACTION_HASH = `dmr_${MSG_ID}:${MY_HASH}:${EMOJI}`;

const signedMessageRow = (author: typeof myIdentity, fields: SignableFields) =>
	signRow(author, fields as Record<string, unknown>, 'dms_') as SignableFields & { sign_b64: string; sign_hash: string };
const GENESIS_ROW = signedMessageRow(myIdentity, {
	message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
	content_b64: 'enc(original)', deleted_flag: false, refs_map_b64: null,
	parent_sign_hash: null, owner_timestamp: 1000,
});
const SIGN_HASH = GENESIS_ROW.sign_hash;

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections: { cards: ReturnType<typeof makeCollection>; dialog: Record<string, ReturnType<typeof makeCollection>> };

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
let outboxBacking: ReturnType<typeof makeMemoryStore>;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };
const rowOf = (m: Mutation) => (m.modified ?? m.changes)!;

let sent: Array<{ relation: string; type: string; row: Record<string, unknown> }>;
/** Per-reaction_hash controllable HTTP responses; default: accept. */
let httpImpl: (m: Mutation) => Promise<Response> | Response;

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string): Mutation =>
			type === 'insert'
				? { type, modified: row, syncMetadata: { relation } }
				: { type, original: {}, changes: row, syncMetadata: { relation } },
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			const m = mutations[0];
			sent.push({ relation: m.syncMetadata.relation, type: m.type, row: rowOf(m) });
			return httpImpl(m);
		},
	},
}));

vi.mock('@/lib/data/intents', () => {
	const store = new Map<string, { id: string; userHash: string; relation: string; intent: unknown }>();
	let seq = 0;
	return {
		onIntentChange: () => () => {},
		enqueueIntent: async (intent: unknown, userHash: string, relation: string) => {
			const id = `test-intent-${seq++}`;
			store.set(id, { id, userHash, relation, intent });
			return id;
		},
		updateIntent: async (id: string, intent: unknown) => {
			const existing = store.get(id);
			if (!existing) return false;
			store.set(id, { ...existing, intent });
			return true;
		},
		resolveIntent: async () => true,
		getIntent: async (id: string) => store.get(id) ?? null,
		intentsOf: async (userHash: string) => ({ entries: [...store.values()].filter((e) => e.userHash === userHash), issues: [] }),
	};
});

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => myIdentity.vault,
		}),
	},
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
		computeReactionHash: (_k: unknown, messageId: string, reactor: string, emoji: string) => `dmr_${messageId}:${reactor}:${emoji}`,
		encryptContent: async (_k: unknown, text: string) => `enc(${text})`,
		decryptContent: async (_k: unknown, ciphertext: unknown) =>
			typeof ciphertext === 'string' && ciphertext.startsWith('enc(') && ciphertext.endsWith(')')
				? ciphertext.slice(4, -1) : null,
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

const ok = (mutations: Mutation[]): Response => ({
	status: 200,
	json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
}) as unknown as Response;

const rejected = (mutations: Mutation[]): Response => ({
	status: 422,
	json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
}) as unknown as Response;

const flush = async () => {
	for (let i = 0; i < 10; i++) {
		for (let j = 0; j < 20; j++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
};

const logicalKeyOf = (messageId: string) => `${DIALOG_HASH}|${messageId}|${EMOJI}`;

const liveReactionItem = (store: ReturnType<typeof useDialogsStore>, messageId = MSG_ID) =>
	[...store.optimisticItems.values()].find((item: { type: string; logicalKey?: string }) =>
		item.type === 'reaction' && item.logicalKey === logicalKeyOf(messageId));

const seenActive = (store: ReturnType<typeof useDialogsStore>, messageId = MSG_ID): boolean =>
	liveReactionItem(store, messageId)?.desiredActive ?? false;

beforeEach(() => {
	setActivePinia(createPinia());
	sent = [];
	httpImpl = (mutations) => ok([mutations] as unknown as Mutation[]);
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	outboxBacking = makeMemoryStore();
	_setStorageForTests(outboxBacking);
	collections = {
		cards: makeCollection({ [MY_HASH]: myIdentity.card, [PEER_HASH]: peerIdentity.card }),
		dialog: {
			keys: makeCollection({ [`${DIALOG_HASH}|${MY_HASH}`]: signedDialogKeyRow(myIdentity, { dialog_hash: DIALOG_HASH, peer_hash: PEER_HASH }) }),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
	startLeaderElection(MY_HASH, () => {});
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
});

const toggle = (store: ReturnType<typeof useDialogsStore>, messageId = MSG_ID) =>
	store.toggleReaction(PEER_HASH, { messageId, messageSignHash: SIGN_HASH, emoji: EMOJI, active: seenActive(store, messageId) });

const clickB = async (s: ReturnType<typeof useDialogsStore>) => {
	await toggle(s);
	expect(liveReactionItem(s)!.desiredActive).toBe(false);
	await toggle(s);
	expect(liveReactionItem(s)!.desiredActive).toBe(true);
};

describe('a permanently rejected reaction write blocks the next one honestly, via the real dependency discovery (L17-01/R4)', () => {
	it('1-3. A permanent rejection quarantines A and durably blocks B — never a false synced, never a hidden dispatch', async () => {
		_setLeaderForTests(true);
		await recordAccepted('dialog_message_reactions', REACTION_HASH, {
			reaction_hash: REACTION_HASH, dialog_hash: DIALOG_HASH, message_id: MSG_ID,
			message_sign_hash: SIGN_HASH, reactor_hash: MY_HASH, type_b64: '',
			deleted_flag: true, owner_timestamp: 500,
		});

		let resolveHttp: ((v: Response) => void) | null = null;
		httpImpl = () => new Promise<Response>((r) => { resolveHttp = r; });

		toggle(store()); // click A: ON
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0].type).toBe('update'); // chained — same reaction_hash as the seeded tombstone

		await clickB(store()); // click B — queued behind A's still-pending HTTP call
		await new Promise((r) => setTimeout(r, 20));
		expect(sent).toHaveLength(1); // B has not reached transport yet — still behind A in reactionQueues

		resolveHttp!(rejected([{ type: 'update', changes: sent[0].row, syncMetadata: { relation: 'dialog_message_reactions' } }]));
		await flush();

		const quarantined = await quarantinedEntries(MY_HASH);
		expect(quarantined.filter((e) => e.relation === 'dialog_message_reactions')).toHaveLength(1);
		const aId = quarantined.find((e) => e.relation === 'dialog_message_reactions')!.id;

		expect(sent).toHaveLength(1);
		const blocked = await blockedEntries(MY_HASH);
		const bEntry = blocked.find((e) => e.relation === 'dialog_message_reactions');
		expect(bEntry).toBeTruthy();
		expect(bEntry!.dependsOn).toContain(aId);

		const issues = await blockedDependentIssues(MY_HASH);
		const issue = issues.find((i) => i.entry.id === bEntry!.id);
		expect(issue!.blockers[0]).toMatchObject({ id: aId, status: 'quarantined' });

		const live = liveReactionItem(store());
		expect(live).toBeTruthy();
		expect(live!.status).toBe('syncing');
	});

	it('1-3b. the same holds when A\'s rejection arrives via the QUEUED path (handle.acceptance resolves, never throws)', async () => {
		_setLeaderForTests(false);
		await recordAccepted('dialog_message_reactions', REACTION_HASH, {
			reaction_hash: REACTION_HASH, dialog_hash: DIALOG_HASH, message_id: MSG_ID,
			message_sign_hash: SIGN_HASH, reactor_hash: MY_HASH, type_b64: '',
			deleted_flag: true, owner_timestamp: 500,
		});
		httpImpl = (m) => rejected([m]); // whatever drains first gets rejected

		toggle(store()); // click A: ON — durably queued, not yet dispatched
		await flush();
		await clickB(store()); // click B — queued behind A's still-pending acceptance
		await flush();
		expect(sent).toHaveLength(0); // still follower — nothing dispatched yet

		_setLeaderForTests(true);
		const { drainPendingWrites } = await import('@/lib/data/ingest');
		drainPendingWrites(MY_HASH, new Uint8Array(32));
		await flush();

		const quarantined = await quarantinedEntries(MY_HASH);
		expect(quarantined.filter((e) => e.relation === 'dialog_message_reactions')).toHaveLength(1);
		const aId = quarantined.find((e) => e.relation === 'dialog_message_reactions')!.id;

		const blocked = await blockedEntries(MY_HASH);
		const bEntry = blocked.find((e) => e.relation === 'dialog_message_reactions');
		expect(bEntry).toBeTruthy();
		expect(bEntry!.dependsOn).toContain(aId);
		expect(sent.filter((s) => s.relation === 'dialog_message_reactions')).toHaveLength(1); // only A ever reached transport

		const live = liveReactionItem(store());
		expect(live!.status).toBe('syncing'); // never 'synced'
	});

	it('4. explicit discard of A does not unblock B and does not become an accepted base for it', async () => {
		_setLeaderForTests(true);
		await recordAccepted('dialog_message_reactions', REACTION_HASH, {
			reaction_hash: REACTION_HASH, dialog_hash: DIALOG_HASH, message_id: MSG_ID,
			message_sign_hash: SIGN_HASH, reactor_hash: MY_HASH, type_b64: '',
			deleted_flag: true, owner_timestamp: 500,
		});
		let resolveHttp: ((v: Response) => void) | null = null;
		httpImpl = () => new Promise<Response>((r) => { resolveHttp = r; });

		toggle(store());
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		await clickB(store());
		await new Promise((r) => setTimeout(r, 20));

		resolveHttp!(rejected([{ type: 'update', changes: sent[0].row, syncMetadata: { relation: 'dialog_message_reactions' } }]));
		await flush();

		const aId = (await quarantinedEntries(MY_HASH)).find((e) => e.relation === 'dialog_message_reactions')!.id;
		await discardEntry(aId);

		expect((await blockedEntries(MY_HASH)).some((e) => e.relation === 'dialog_message_reactions')).toBe(true);
		expect(sent).toHaveLength(1); // still never reached transport a second time

		const accepted = await import('@/lib/data/acceptedSnapshot').then((m) =>
			m.getAccepted('dialog_message_reactions', REACTION_HASH));
		expect(accepted?.owner_timestamp).toBe(500); // the original seeded tombstone, untouched
	});

	it('5. once A is genuinely accepted, B is built as an update/tombstone from exactly that accepted content and dispatches independently', async () => {
		_setLeaderForTests(true);
		httpImpl = (m) => ok([m]);

		await toggle(store()); // A: ON, accepted immediately (leader, no deps)
		await flush();
		expect(sent).toHaveLength(1);
		expect(sent[0].row.deleted_flag).toBe(false);

		await toggle(store()); // B: OFF, built AFTER A's acceptance
		await flush();

		expect(sent).toHaveLength(2);
		expect(sent[1].type).toBe('update');
		expect(sent[1].row.deleted_flag).toBe(true);
		expect((await blockedEntries(MY_HASH)).some((e) => e.relation === 'dialog_message_reactions')).toBe(false);
	});

	it('6. an independent reaction (different message) keeps dispatching while the first reaction chain is blocked', async () => {
		_setLeaderForTests(true);
		await recordAccepted('dialog_message_reactions', REACTION_HASH, {
			reaction_hash: REACTION_HASH, dialog_hash: DIALOG_HASH, message_id: MSG_ID,
			message_sign_hash: SIGN_HASH, reactor_hash: MY_HASH, type_b64: '',
			deleted_flag: true, owner_timestamp: 500,
		});
		let resolveHttp: ((v: Response) => void) | null = null;
		const OTHER_MSG = 'dmsg_' + '9'.repeat(128);
		httpImpl = (m) => {
			if (rowOf(m).message_id === MSG_ID) return new Promise<Response>((r) => { resolveHttp = r; });
			return ok([m]);
		};

		const store1 = store();
		toggle(store1); // A on the first reaction
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		toggle(store1); // B queued behind A

		await toggle(store1, OTHER_MSG);
		await flush();

		expect(sent.some((s) => s.row.message_id === OTHER_MSG)).toBe(true); // C dispatched, unaffected by A/B

		resolveHttp!(rejected([{ type: 'update', changes: sent[0].row, syncMetadata: { relation: 'dialog_message_reactions' } }]));
		await flush();
	});

	it('7. a reload between A\'s failure and B\'s block does not change the verdict', async () => {
		_setLeaderForTests(true);
		await recordAccepted('dialog_message_reactions', REACTION_HASH, {
			reaction_hash: REACTION_HASH, dialog_hash: DIALOG_HASH, message_id: MSG_ID,
			message_sign_hash: SIGN_HASH, reactor_hash: MY_HASH, type_b64: '',
			deleted_flag: true, owner_timestamp: 500,
		});
		let resolveHttp: ((v: Response) => void) | null = null;
		httpImpl = () => new Promise<Response>((r) => { resolveHttp = r; });

		toggle(store());
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		await clickB(store());
		await new Promise((r) => setTimeout(r, 20));
		resolveHttp!(rejected([{ type: 'update', changes: sent[0].row, syncMetadata: { relation: 'dialog_message_reactions' } }]));
		await flush();

		const before = await blockedEntries(MY_HASH);
		expect(before.some((e) => e.relation === 'dialog_message_reactions')).toBe(true);

		_setStorageForTests({ ...outboxBacking });
		const after = await blockedEntries(MY_HASH);
		expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
	});
});

function store() {
	return useDialogsStore();
}
