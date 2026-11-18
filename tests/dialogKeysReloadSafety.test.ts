import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { pinActiveSession } from '@/lib/data/sessionGuard';
import { makeTestIdentity } from './helpers/signedFixtures';

const ME = makeTestIdentity(1, 'me');
const PEER = makeTestIdentity(2, 'peer');
const MY_HASH = ME.userHash;
const PEER_HASH = PEER.userHash;
const DIALOG_HASH = 'di_' + '1'.repeat(128);

const keysCollection = { rows: new Map<string, unknown>(), async preload() {}, get: (k: string) => keysCollection.rows.get(k) };
const cardsCollection = {
	rows: new Map<string, unknown>([[PEER_HASH, PEER.card]]),
	async preload() {},
	get: (k: string) => cardsCollection.rows.get(k),
};
vi.mock('@/lib/data/collections', () => ({
	getDialogCollections: () => ({ keys: keysCollection }),
	getUserCardsCollection: () => cardsCollection,
}));

let wrapCalls = 0;
let enqueueIntentCalls = 0;
const enqueued: Array<{ row: Record<string, unknown>; mutationType: string }> = [];
vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));
vi.mock('@buckitup/pq-client/dialogs', async (importOriginal) => ({
	...(await importOriginal<typeof import('@buckitup/pq-client/dialogs')>()),
	deriveSenderMsgKey: () => new Uint8Array(32),
	wrapSenderMsgKey: async () => {
		wrapCalls++;
		return { peer_kem_wrap_key_b64: 'wrap-' + wrapCalls, peer_wrapped_msg_key_b64: 'wrapped-' + wrapCalls };
	},
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ME.vault,
		}),
	},
}));
vi.mock('@/lib/data/intents', () => ({
	onIntentChange: () => () => {},
	enqueueIntent: async (intent: { row: Record<string, unknown>; mutationType: string }) => {
		enqueueIntentCalls++;
		enqueued.push(intent);
		return 'intent-should-not-happen-after-acceptance';
	},
	intentsOf: async () => ({ entries: [], issues: [] }),
}));

const { ensureOwnDialogKeyPublished } = await import('@/lib/data/messageIntent');
const { recordAccepted, _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { kvGet, kvSet, _setStoreForTests } = await import('@/lib/data/localStore');
const PUBLISHED_HERE = `dialog-key-published-here:${MY_HASH}|${DIALOG_HASH}`;

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

beforeEach(() => {
	keysCollection.rows.clear();
	wrapCalls = 0;
	enqueueIntentCalls = 0;
	enqueued.length = 0;
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setStoreForTests(makeStorage());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
});

describe('ensureOwnDialogKeyPublished survives a reload between ACCEPTED and the shape echo', () => {
	it('does not mint a second wrap when this device\'s own key was already accepted, even though the shape row is still empty (simulated reload)', async () => {
		await kvSet(PUBLISHED_HERE, true, MY_HASH);
		await recordAccepted('dialog_keys', `${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH,
			deleted_flag: false, owner_timestamp: 1000, sign_b64: 'sig-already-accepted',
		}, MY_HASH);

		const token = pinActiveSession(MY_HASH, 'test:start');
		await ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);

		expect(wrapCalls).toBe(0);
		expect(enqueueIntentCalls).toBe(0);
	});

	it('still mints a wrap normally when nothing was ever accepted and the shape is empty', async () => {
		const token = pinActiveSession(MY_HASH, 'test:start');
		enqueueIntentCalls = 0;
		await ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token).catch(() => {});
		expect(wrapCalls).toBe(1);
	});

	it('republishes, as an update with a newer timestamp, a key row this device has not published under the current derivation', async () => {
		await recordAccepted('dialog_keys', `${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH,
			deleted_flag: false, owner_timestamp: 1000, sign_b64: 'sig-before-the-switch',
		}, MY_HASH);
		const token = pinActiveSession(MY_HASH, 'test:start');
		await ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token).catch(() => {});

		expect(wrapCalls).toBe(1);
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].mutationType).toBe('update');
		expect(Number(enqueued[0].row.owner_timestamp)).toBeGreaterThan(1000);
		expect(enqueued[0].row).toMatchObject({ dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false });
	});

	it('marks the key as published here only once the server accepted it', async () => {
		const token = pinActiveSession(MY_HASH, 'test:start');
		await ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token).catch(() => {});
		expect(wrapCalls).toBe(1);
		expect(await kvGet(PUBLISHED_HERE)).toBeUndefined();
	});
});
