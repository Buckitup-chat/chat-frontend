import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeTestIdentity, signRow, signedDialogKeyRow } from './helpers/signedFixtures';
import type { SignableFields } from '@/lib/pq/signature';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop as stopOutboxLoop, startLeaderElection, stopLeaderElection,
	pendingEntries,
} from '@/lib/data/outbox';
import { drainPendingWrites, stopDrainLoop, sendMutationsAndAwaitShape } from '@/lib/data/ingest';
import { probeAllBlocked, resetGate, isWriteBlocked } from '@/lib/data/accessGate';

const me = makeTestIdentity(1);
const peer = makeTestIdentity(2);
const MY_HASH = me.userHash;
const PEER_HASH = peer.userHash;
const DIALOG_HASH = 'di_' + '3'.repeat(128);
const MSG_ID = 'dmsg_' + '4'.repeat(128);
const OTHER_MSG_ID = 'dmsg_' + '5'.repeat(128);
const EMOJI = '\u{1F44D}';

const signedMessageRow = (fields: SignableFields) =>
	signRow(me, fields as Record<string, unknown>, 'dms_') as SignableFields & { sign_b64: string; sign_hash: string };
const SIGN_HASH = signedMessageRow({
	message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, content_b64: 'enc(original)',
	deleted_flag: false, refs_map_b64: null, parent_sign_hash: null, owner_timestamp: 1000,
}).sign_hash;

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
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUserHash: MY_HASH }) }));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };

const grants = new Set<string>();
const shapeOf = (relation: string) => (relation === 'files' ? 'file' : relation);
let posted: string[];
let refuseFiles: boolean;

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string): Mutation =>
			type === 'insert'
				? { type, modified: row, syncMetadata: { relation } }
				: { type, original: {}, changes: row, syncMetadata: { relation } },
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			const results = mutations.map((m, index) => {
				if (!grants.has(shapeOf(m.syncMetadata.relation))) return { index, status: 'error', error: 'not_in_trust_chain', max_depth: 7 };
				if (refuseFiles && m.syncMetadata.relation === 'files') return { index, status: 'error', error: 'validation_failed', details: { chunk_count: ['is invalid'] } };
				return { index, status: 'ok', txid: 100 + posted.length };
			});
			for (const m of mutations) posted.push(`${m.syncMetadata.relation}:${results[0].status}`);
			const status = results.every((r) => r.status === 'ok') ? 200 : results.every((r) => r.error === 'not_in_trust_chain') ? 403 : 422;
			return { status, json: async () => ({ results }) } as unknown as Response;
		},
	},
}));

vi.mock('@/libs/enigma', () => ({ decodeHexOrBase64: (s: string) => (s ? new Uint8Array(Buffer.from(s, 'base64')) : null) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ currentUserHash: MY_HASH, exportVaultKeys: async () => me.vault }) },
}));
vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
		computeReactionHash: (_k: unknown, messageId: string, reactor: string, emoji: string) => `dmr_${messageId}:${reactor}:${emoji}`,
		encryptContent: async (_k: unknown, text: string) => `enc(${typeof text === 'string' ? text : JSON.stringify(text)})`,
		decryptContent: async () => null,
	},
}));

const chunkCache = new Map<string, Uint8Array>();
vi.mock('@/lib/data/chunkCache', () => ({
	putCachedChunk: async (fileId: string, index: number, bytes: Uint8Array) => { chunkCache.set(`${fileId}:${index}`, bytes); },
	getCachedChunk: async (fileId: string, index: number) => chunkCache.get(`${fileId}:${index}`) ?? null,
	requestPersistentStorage: async () => false,
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { useTransfersStore } = await import('@/store/transfers.store');

let projections: ReturnType<typeof makeMemoryStore>;
let chunkPuts: ReturnType<typeof vi.fn>;

const signIn = () => {
	startLeaderElection(MY_HASH, () => {});
	_setLeaderForTests(true);
	drainPendingWrites(MY_HASH, new Uint8Array(32));
};

beforeEach(() => {
	setActivePinia(createPinia());
	grants.clear();
	grants.add('dialog_keys');
	posted = [];
	refuseFiles = false;
	chunkCache.clear();
	chunkPuts = vi.fn(async () => new Response(null, { status: 200 }));
	vi.stubGlobal('fetch', chunkPuts);
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setStorageForTests(makeMemoryStore());
	_setIntentStorageForTests(makeMemoryStore());
	projections = makeMemoryStore();
	_setProjectionStorageForTests(projections);
	_setOwnObservedTailsStorageForTests(makeMemoryStore());
	collections = {
		cards: makeCollection({ [MY_HASH]: me.card, [PEER_HASH]: peer.card }),
		dialog: {
			keys: makeCollection({ [`${DIALOG_HASH}|${MY_HASH}`]: signedDialogKeyRow(me, { dialog_hash: DIALOG_HASH, peer_hash: PEER_HASH }) }),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
	signIn();
});

afterEach(() => {
	resetGate();
	stopDrainLoop();
	_setLeaderForTests(null);
	stopOutboxLoop();
	stopLeaderElection();
	vi.unstubAllGlobals();
});

const approve = async (shape: string) => {
	grants.add(shape);
	await vi.waitFor(() => expect(isWriteBlocked(shape)).toBe(true));
	probeAllBlocked();
};

describe('messages', () => {
	const send = (text: string) => {
		const statuses: string[] = [];
		void useDialogsStore().sendMessage(PEER_HASH, text, (status: string) => { statuses.push(status); });
		return statuses;
	};

	it('the first refused message and a later one are awaiting approval, not errors; approved, both are synced', async () => {
		const first = send('first');
		await vi.waitFor(() => expect(first).toContain('awaiting_approval'));
		const second = send('second');
		await vi.waitFor(() => expect(second).toContain('awaiting_approval'));
		expect(posted).toEqual(['dialog_messages:error']);
		await approve('dialog_messages');

		await vi.waitFor(() => expect(first.at(-1)).toBe('synced'));
		await vi.waitFor(() => expect(second.at(-1)).toBe('synced'));
		expect([...first, ...second]).not.toContain('error');
	});

	it('after a reload the stored message is shown as awaiting approval, not as queued for the network', async () => {
		const first = send('first');
		await vi.waitFor(() => expect(first).toContain('awaiting_approval'));

		setActivePinia(createPinia());
		const reloaded = useDialogsStore();
		await vi.waitFor(() => expect([...reloaded.optimisticItems.values()].find((i: { text?: string }) => i.text === 'first')?.status).toBe('awaiting_approval'));
	});
});

describe('message edits', () => {
	it('an edit refused by the trust chain is reported as awaiting approval at once — neither an error nor a wait for the approval', async () => {
		grants.add('dialog_messages');
		const statuses: string[] = [];
		const messageId = await useDialogsStore().sendMessage(PEER_HASH, 'original', (status: string) => { statuses.push(status); });
		await vi.waitFor(() => expect(statuses.at(-1)).toBe('synced'));
		grants.delete('dialog_messages');

		const outcome = await Promise.race([
			useDialogsStore().editMessage(PEER_HASH, messageId, 'edited').then((r: { status: string }) => r.status, (e: Error) => `threw: ${e.message}`),
			new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
		]);

		expect(outcome).toBe('awaiting_approval');
		expect(posted.at(-1)).toBe('dialog_messages:error');
	});
});

describe('reactions', () => {
	const react = (messageId: string) =>
		useDialogsStore().toggleReaction(PEER_HASH, { messageId, messageSignHash: SIGN_HASH, emoji: EMOJI, active: false });
	const statusOf = (optimisticId: string) => useDialogsStore().optimisticItems.get(optimisticId)?.status;

	it('the first refused reaction and a later one are awaiting approval, not errors; approved, both are synced', async () => {
		const first = await react(MSG_ID);
		await vi.waitFor(() => expect(statusOf(first)).toBe('awaiting_approval'));
		const second = await react(OTHER_MSG_ID);
		await vi.waitFor(() => expect(statusOf(second)).toBe('awaiting_approval'));

		await approve('dialog_message_reactions');

		await vi.waitFor(() => expect(statusOf(first)).toBe('synced'));
		await vi.waitFor(() => expect(statusOf(second)).toBe('synced'));
	});
});

describe('a file whose manifest is held', () => {
	const file = (name: string) => {
		const bytes = new TextEncoder().encode(`contents of ${name}`);
		return { name, size: bytes.length, type: 'application/octet-stream', lastModified: 1_700_000_000_000, arrayBuffer: async () => bytes.buffer };
	};
	type Row = { id: string; status: string };
	const heldUpload = async () => {
		grants.add('dialog_messages');
		const transfers = useTransfersStore();
		const items = () => transfers.items as Row[];
		await transfers.enqueueBatch(PEER_HASH, [file('a.bin')], 'caption');
		await vi.waitFor(() => expect(items()[0]?.status).toBe('awaiting_approval'));
		await vi.waitFor(async () => expect((await pendingEntries(MY_HASH)).map((e) => e.relation)).toEqual(['files', 'dialog_messages']));
		const [manifest, message] = await pendingEntries(MY_HASH);
		expect(message.dependsOn).toContain(manifest.id);
		await new Promise((r) => setTimeout(r, 50));
		expect(posted).toEqual(['files:error']);
		return { transfers, items };
	};
	const reload = () => {
		resetGate();
		stopDrainLoop();
		stopOutboxLoop();
		stopLeaderElection();
		setActivePinia(createPinia());
		signIn();
	};
	const ownMessage = () => [...useDialogsStore().optimisticItems.values()].find((i: { type: string; text?: string }) => i.type === 'message' && i.text?.includes('caption')) as { status: string } | undefined;

	it('waits for approval without an error; approved, the manifest goes and then its message — no chunk uploaded again', async () => {
		const { items } = await heldUpload();

		await approve('file');

		await vi.waitFor(() => expect(posted).toEqual(['files:error', 'files:ok', 'dialog_messages:ok']));
		await vi.waitFor(() => expect(items()[0]?.status).toBe('done'));
		expect(chunkPuts).toHaveBeenCalledTimes(1);
	});

	it('a reload while it waits loses nothing: the message shows as awaiting approval, and approval sends the manifest, then the message — no chunk again, no orphan manifest', async () => {
		await heldUpload();

		reload();
		expect(useTransfersStore().items).toEqual([]);
		await vi.waitFor(() => expect(ownMessage()?.status).toBe('awaiting_approval'));

		await approve('file');

		await vi.waitFor(() => expect(posted).toEqual(['files:error', 'files:ok', 'dialog_messages:ok']));
		await vi.waitFor(async () => expect(await pendingEntries(MY_HASH)).toEqual([]));
		expect(chunkPuts).toHaveBeenCalledTimes(1);
	});

	it('a manifest refused after approval leaves the row refused, the message unsent and waiting on it, and no unobserved rejection', async () => {
		const { items } = await heldUpload();
		refuseFiles = true;

		await approve('file');

		await vi.waitFor(() => expect(items()[0]?.status).toBe('rejected'));
		await new Promise((r) => setTimeout(r, 50));
		expect(posted).toEqual(['files:error', 'files:error']);
		const message = (await pendingEntries(MY_HASH)).find((e) => e.relation === 'dialog_messages');
		expect(message).toBeTruthy();
	});

	it('a message that cannot be stored fails the batch, not the uploaded row: no retry offered, no unobserved rejection, the manifest still settles', async () => {
		_setProjectionStorageForTests({ ...makeMemoryStore(), async set() { throw new Error('storage full'); } });
		grants.add('dialog_messages');
		const transfers = useTransfersStore();
		const items = () => transfers.items as Row[];
		await transfers.enqueueBatch(PEER_HASH, [file('a.bin')], 'caption');

		await vi.waitFor(() => expect(items()[0]?.status).toBe('awaiting_approval'));
		await new Promise((r) => setTimeout(r, 50));
		expect((await pendingEntries(MY_HASH)).map((e) => e.relation)).toEqual(['files']); // no message was stored

		await approve('file');
		await vi.waitFor(() => expect(items()[0]?.status).toBe('done'));
		expect(posted).toEqual(['files:error', 'files:ok']);
		expect(chunkPuts).toHaveBeenCalledTimes(1);
	});

	it.fails('a batch of two: the first manifest held, the second file still uploading, a reload, then approval — the message is not lost and no manifest goes out without it', async () => {
		grants.add('dialog_messages');
		let releaseSecond!: () => void;
		chunkPuts.mockImplementation(async () => {
			if (chunkPuts.mock.calls.length === 1) return new Response(null, { status: 200 });
			await new Promise<void>((resolve) => { releaseSecond = resolve; });
			return new Response(null, { status: 200 });
		});
		const transfers = useTransfersStore();
		const items = () => transfers.items as Row[];
		await transfers.enqueueBatch(PEER_HASH, [file('a.bin'), file('b.bin')], 'caption');
		await vi.waitFor(() => expect(items().map((it) => it.status)).toEqual(['awaiting_approval', 'active']));
		await vi.waitFor(() => expect(chunkPuts).toHaveBeenCalledTimes(2));

		reload();
		await approve('file');
		await new Promise((r) => setTimeout(r, 300));
		releaseSecond?.();

		const stored = await pendingEntries(MY_HASH);
		const messageStoredOrSent = posted.includes('dialog_messages:ok') || stored.some((e) => e.relation === 'dialog_messages');
		const manifestWithoutMessage = posted.includes('files:ok') && !messageStoredOrSent;
		expect({ messageStoredOrSent, manifestWithoutMessage, posted }).toEqual({ messageStoredOrSent: true, manifestWithoutMessage: false, posted: expect.anything() });
	});

	it('a message citing a held file whose dependencies could not be read at first, and are read again later, still goes only after the manifest', async () => {
		grants.add('dialog_messages');
		const unreadable = new Set<string>();
		const store = makeMemoryStore();
		_setStorageForTests({ ...store, async get(k: string) { if (unreadable.has(k)) throw new Error('storage read failed'); return store.get(k); } });
		const fileId = 'f_' + 'a'.repeat(32);
		await sendMutationsAndAwaitShape([{
			type: 'insert', syncMetadata: { relation: 'files' },
			modified: { file_id: fileId, uploader_hash: MY_HASH, chunk_count: 1, chunk_size: 1, total_size: 1, chunk_sign_hashes: [], deleted_flag: false, owner_timestamp: 1, sign_b64: 'AAAA' },
		}], new Uint8Array(32));
		const [manifest] = await pendingEntries(MY_HASH);
		expect(manifest.approvalHeld).toBeTruthy();

		unreadable.add(manifest.id);
		void useDialogsStore().sendMessage(PEER_HASH, [{ kind: 'file', name: 'a.bin', size: 1, mimeType: 'application/octet-stream', createdAt: 1, fileId, encSecretB64: 'AAAA' }], () => {});
		await vi.waitFor(async () => {
			const message = (await pendingEntries(MY_HASH)).find((e) => e.relation === 'dialog_messages');
			expect(message?.discoveryBlocked).toBeTruthy();
		});
		unreadable.clear();
		drainPendingWrites(MY_HASH, new Uint8Array(32));
		await vi.waitFor(async () => {
			const message = (await pendingEntries(MY_HASH)).find((e) => e.relation === 'dialog_messages');
			expect(message?.discoveryBlocked).toBeUndefined();
		});
		await new Promise((r) => setTimeout(r, 200));

		expect(posted).toEqual(['files:error']);
		await approve('file');
		await vi.waitFor(() => expect(posted).toEqual(['files:error', 'files:ok', 'dialog_messages:ok']));
	});

	it('a held row cannot be cancelled: it stays, and on approval its manifest and message still go', async () => {
		const { transfers, items } = await heldUpload();

		await transfers.cancel(items()[0].id);
		expect(items()[0]?.status).toBe('awaiting_approval');

		await approve('file');
		await vi.waitFor(() => expect(posted).toEqual(['files:error', 'files:ok', 'dialog_messages:ok']));
	});
});
