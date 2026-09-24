import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startLeaderElection, stopLeaderElection, stopDrainLoop, _setLeaderForTests, _setStorageForTests } from '@/lib/data/outbox';
import { pinActiveSession } from '@/lib/data/sessionGuard';
import { _setAcceptedSnapshotStorageForTests, getAccepted } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';

const MY_HASH = 'u_' + 'a'.repeat(128);
const PEER_HASH = 'u_' + 'b'.repeat(128);
const DIALOG_HASH = 'di_' + '4'.repeat(128);

const awaitTxIdSpy = vi.fn(async () => true);
const keysCollection = {
	rows: new Map<string, unknown>(),
	async preload() {},
	get: (k: string) => keysCollection.rows.get(k),
	utils: { awaitTxId: awaitTxIdSpy },
};
const cardsCollection = {
	rows: new Map<string, unknown>([[PEER_HASH, { user_hash: PEER_HASH, crypt_pkey: 'peer-pkey' }]]),
	async preload() {},
	get: (k: string) => cardsCollection.rows.get(k),
};
vi.mock('@/lib/data/collections', () => ({
	getDialogCollections: () => ({ keys: keysCollection }),
	getUserCardsCollection: () => cardsCollection,
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
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({ sign_skey: 'AAAA', crypt_skey: 'BBBB', evm_skey: 'cc' }),
		}),
	},
}));

let sent: Array<{ relation: string; txid: number }>;
vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) =>
			(type === 'insert' ? { type, modified: row, syncMetadata: { relation } } : { type, changes: row, syncMetadata: { relation } }),
		ingestWithAuthEach: async (mutations: Array<{ syncMetadata: { relation: string } }>) => {
			const relation = mutations[0].syncMetadata.relation;
			const txid = 900 + sent.length;
			sent.push({ relation, txid });
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: txid + index })) }),
			} as unknown as Response;
		},
	},
}));

const { ensureOwnDialogKeyPublished, materializeMessageIntent } = await import('@/lib/data/messageIntent');

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

beforeEach(() => {
	keysCollection.rows.clear();
	awaitTxIdSpy.mockClear();
	sent = [];
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setIntentStorageForTests(makeMemoryStore());
	_setStorageForTests(makeMemoryStore());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

describe('dialog_keys insert completes on SERVER_ACCEPTED, never on shape visibility', () => {
	it('ensureOwnDialogKeyPublished resolves once the server accepts the key, without ever calling awaitTxId, and the accepted snapshot is recorded although the shape row is never echoed', async () => {
		const token = pinActiveSession(MY_HASH, 'test:start');

		await ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);

		expect(sent).toEqual([{ relation: 'dialog_keys', txid: 900 }]);
		expect(awaitTxIdSpy).not.toHaveBeenCalled();
		expect(keysCollection.rows.size).toBe(0);

		const accepted = await getAccepted('dialog_keys', `${DIALOG_HASH}|${MY_HASH}`, MY_HASH);
		expect(accepted?.sender_hash).toBe(MY_HASH);
	});

	it('the dependent message intent materializes right after key acceptance, with the shape still never having gained the key row', async () => {
		const token = pinActiveSession(MY_HASH, 'test:start');

		const readyRow = await materializeMessageIntent({
			kind: 'message',
			relation: 'dialog_messages',
			peerHash: PEER_HASH,
			dialogHash: DIALOG_HASH,
			messageId: 'dmsg_test-1',
			ownerHash: MY_HASH,
			ownerTimestamp: 1,
			parts: [{ kind: 'text', text: 'hello' }],
			observedTails: {},
		}, token);

		expect(readyRow.relation).toBe('dialog_messages');
		expect(readyRow.row.dialog_hash).toBe(DIALOG_HASH);
		expect(sent).toEqual([{ relation: 'dialog_keys', txid: 900 }]);
		expect(awaitTxIdSpy).not.toHaveBeenCalled();
		expect(keysCollection.rows.size).toBe(0);
	});
});
