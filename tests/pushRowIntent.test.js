// §3.1 wired into the real write path: pushRow (dialogs.store.js) durables an
// intent via the real src/lib/data/intents.ts (not stubbed, unlike
// dialogsStore.test.js) before it ever touches the vault or the network.
//
// initDialogKeys is the call site used here because it calls
// exportVaultKeys() twice — once for its own key derivation, once again
// inside pushRow's getSignSkeyBytes() — which lets the second call (the one
// pushRow actually depends on) be made to fail independently of the first,
// exercising exactly the gap §3.1 closes without needing a real locked vault.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { intentsOf, _setIntentStorageForTests, _clearIntentsForTests } from '@/lib/data/intents';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
});

const MY_HASH = 'u_' + '1'.repeat(128);
const PEER_HASH = 'u_' + '2'.repeat(128);
const DIALOG_HASH = 'di_' + '3'.repeat(128);

let collections;
let sent;
let sendImpl;
let vaultCallCount;
let failVaultFromCall; // null = never fail; N = throw starting from the Nth exportVaultKeys() call

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

class MockDurabilityError extends Error {}

vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: (mutations) => sendImpl(mutations),
	DurabilityError: MockDurabilityError,
	OWNER_FIELD: {
		dialog_keys: 'sender_hash',
		dialog_messages: 'sender_hash',
		dialog_message_reactions: 'reactor_hash',
		dialog_message_receipts: 'peer_hash',
	},
}));

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation, row, _skey, type) => ({ type, relation, row, syncMetadata: { relation } }),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => {
				vaultCallCount++;
				if (failVaultFromCall !== null && vaultCallCount >= failVaultFromCall) {
					throw new Error('Vault not loaded');
				}
				return { sign_skey: 'AAAA', crypt_skey: 'BBBB', evm_skey: 'cc' };
			},
		}),
	},
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

beforeEach(async () => {
	setActivePinia(createPinia());
	collections = {
		cards: makeCollection({ [PEER_HASH]: { user_hash: PEER_HASH, crypt_pkey: 'peerkey' } }),
		dialog: { keys: makeCollection(), messages: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
	};
	sent = [];
	sendImpl = async (mutations) => { sent.push(...mutations); return { txids: [] }; };
	vaultCallCount = 0;
	failVaultFromCall = null;

	const map = new Map();
	_setIntentStorageForTests({
		map,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	});
	await _clearIntentsForTests();
});

describe('pushRow durables an intent before signing (§3.1)', () => {
	it('a vault failure at the signing step leaves the intent durable — nothing is lost', async () => {
		// 1st exportVaultKeys() call (initDialogKeys' own key derivation)
		// succeeds; the 2nd (inside pushRow -> getSignSkeyBytes) fails.
		failVaultFromCall = 2;
		const store = useDialogsStore();

		await expect(store.initDialogKeys(PEER_HASH)).rejects.toThrow(/vault/i);

		expect(sent).toHaveLength(0); // never reached the network
		const intents = await intentsOf(MY_HASH);
		expect(intents).toHaveLength(1);
		expect(intents[0].relation).toBe('dialog_keys');
		expect(intents[0].intent.row.sender_hash).toBe(MY_HASH);
		expect(intents[0].intent.row.dialog_hash).toBe(DIALOG_HASH);
	});

	it('a successful write resolves the intent — it does not accumulate', async () => {
		const store = useDialogsStore();
		await store.initDialogKeys(PEER_HASH);

		expect(sent).toHaveLength(1);
		expect(await intentsOf(MY_HASH)).toEqual([]);
	});

	it('a network failure after durability still resolves the intent — outbox.ts owns it from here', async () => {
		sendImpl = async () => { throw new Error('ingest network error'); };
		const store = useDialogsStore();

		await expect(store.initDialogKeys(PEER_HASH)).rejects.toThrow(/network error/i);

		// the intent's one job — surviving the pre-signing gap — is done;
		// outbox.ts's own durable/retry/quarantine state is now authoritative
		expect(await intentsOf(MY_HASH)).toEqual([]);
	});

	it('a DurabilityError from the outbox leaves the intent behind — nothing durable happened yet', async () => {
		sendImpl = async () => { throw new MockDurabilityError('could not store'); };
		const store = useDialogsStore();

		await expect(store.initDialogKeys(PEER_HASH)).rejects.toThrow();

		expect(await intentsOf(MY_HASH)).toHaveLength(1);
	});

	it('refuses to sign or send when the intent itself cannot be made durable', async () => {
		_setIntentStorageForTests({
			async get() { throw new Error('private mode'); },
			async set() { throw new Error('private mode'); },
			async delete() {},
			async keys() { throw new Error('private mode'); },
			async clear() {},
		});
		const store = useDialogsStore();

		await expect(store.initDialogKeys(PEER_HASH)).rejects.toThrow(/could not be stored/i);
		expect(sent).toHaveLength(0);
		expect(vaultCallCount).toBe(1); // only initDialogKeys' own derivation ran — pushRow never asked for the key
	});
});
