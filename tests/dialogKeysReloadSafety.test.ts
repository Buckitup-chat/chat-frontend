import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { pinActiveSession } from '@/lib/data/sessionGuard';

const MY_HASH = 'u_' + 'a'.repeat(128);
const PEER_HASH = 'u_' + 'b'.repeat(128);
const DIALOG_HASH = 'di_' + '1'.repeat(128);

const keysCollection = { rows: new Map<string, unknown>(), async preload() {}, get: (k: string) => keysCollection.rows.get(k) };
const cardsCollection = {
	rows: new Map<string, unknown>([[PEER_HASH, { user_hash: PEER_HASH, crypt_pkey: 'peer-pkey' }]]),
	async preload() {},
	get: (k: string) => cardsCollection.rows.get(k),
};
vi.mock('@/lib/data/collections', () => ({
	getDialogCollections: () => ({ keys: keysCollection }),
	getUserCardsCollection: () => cardsCollection,
}));

let wrapCalls = 0;
let enqueueIntentCalls = 0;
vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));
vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => {
			wrapCalls++;
			return { peerKemWrapKeyB64: 'wrap-' + wrapCalls, peerWrappedMsgKeyB64: 'wrapped-' + wrapCalls };
		},
	},
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({ sign_skey: 'AAAA', crypt_skey: 'BBBB', evm_skey: 'cc' }),
		}),
	},
}));
vi.mock('@/lib/data/intents', () => ({
	onIntentChange: () => () => {},
	enqueueIntent: async () => { enqueueIntentCalls++; return 'intent-should-not-happen-after-acceptance'; },
	intentsOf: async () => ({ entries: [], issues: [] }),
}));

const { ensureOwnDialogKeyPublished } = await import('@/lib/data/messageIntent');
const { recordAccepted, _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

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
	_setAcceptedSnapshotStorageForTests(makeStorage());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
});

describe('ensureOwnDialogKeyPublished survives a reload between ACCEPTED and the shape echo', () => {
	it('does not mint a second wrap when this device\'s own key was already accepted, even though the shape row is still empty (simulated reload)', async () => {
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
});
