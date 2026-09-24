import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startLeaderElection, stopLeaderElection, currentSessionToken, SessionFencedError } from '@/lib/data/outbox';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const PEER_HASH = 'u_' + 'c'.repeat(128);
const DIALOG_HASH = 'di_' + '1'.repeat(128);

let releaseVaultExport: (() => void) | null = null;
let vaultExportDeferred = false;
let vaultExportCalls = 0;

let releaseCardsPreload: (() => void) | null = null;
let cardsPreloadDeferred = false;
let cardsPreloadCalls = 0;

let wrapSenderMsgKeyCalls = 0;
let enqueueIntentCalls = 0;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => {
				vaultExportCalls++;
				if (vaultExportDeferred) await new Promise<void>((resolve) => { releaseVaultExport = resolve; });
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
		wrapSenderMsgKey: async () => {
			wrapSenderMsgKeyCalls++;
			return { peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' };
		},
	},
}));

const keysCollection = {
	rows: new Map<string, unknown>(),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
};

const cardsCollection = {
	rows: new Map<string, unknown>([[PEER_HASH, { user_hash: PEER_HASH, crypt_pkey: 'peer-pkey' }]]),
	async preload() {
		cardsPreloadCalls++;
		if (cardsPreloadDeferred) await new Promise<void>((resolve) => { releaseCardsPreload = resolve; });
	},
	get(key: string) { return this.rows.get(key); },
};

vi.mock('@/lib/data/collections', () => ({
	getDialogCollections: () => ({ keys: keysCollection }),
	getUserCardsCollection: () => cardsCollection,
}));

vi.mock('@/lib/data/intents', () => ({
	onIntentChange: () => () => {},
	enqueueIntent: async () => { enqueueIntentCalls++; return 'intent-should-not-happen'; },
	intentsOf: async () => ({ entries: [], issues: [] }),
}));

const { ensureOwnDialogKeyPublished, pinActiveSession } = await import('@/lib/data/messageIntent');

beforeEach(() => {
	keysCollection.rows.clear();
	vaultExportDeferred = false;
	vaultExportCalls = 0;
	releaseVaultExport = null;
	cardsPreloadDeferred = false;
	cardsPreloadCalls = 0;
	releaseCardsPreload = null;
	wrapSenderMsgKeyCalls = 0;
	enqueueIntentCalls = 0;
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
});

describe('ensureOwnDialogKeyPublished: a session switch is caught inside each named internal await (§1)', () => {
	it('a switch during vault export (ownSenderMsgKey) is caught before the peer card is ever read', async () => {
		vaultExportDeferred = true;
		const token = pinActiveSession(MY_HASH, 'test:start');

		const call = ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);

		await vi.waitFor(() => expect(vaultExportCalls).toBe(1));
		stopLeaderElection();
		startLeaderElection(OTHER_HASH, () => {});
		releaseVaultExport?.();

		await expect(call).rejects.toThrow(SessionFencedError);
		expect(cardsPreloadCalls).toBe(0);
		expect(wrapSenderMsgKeyCalls).toBe(0);
		expect(enqueueIntentCalls).toBe(0);
	});

	it('a switch during the peer-card preload is caught before the key is ever wrapped or published', async () => {
		cardsPreloadDeferred = true;
		const token = pinActiveSession(MY_HASH, 'test:start');

		const call = ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);

		await vi.waitFor(() => expect(cardsPreloadCalls).toBe(1));
		stopLeaderElection();
		startLeaderElection(OTHER_HASH, () => {});
		releaseCardsPreload?.();

		await expect(call).rejects.toThrow(SessionFencedError);
		expect(wrapSenderMsgKeyCalls).toBe(0);
		expect(enqueueIntentCalls).toBe(0);
	});

	it('a switch during the second vault export (for signing) is caught before signAndDispatchIntent ever runs', async () => {
		vaultExportDeferred = true;
		const token = pinActiveSession(MY_HASH, 'test:start');

		const call = ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);
		await vi.waitFor(() => expect(vaultExportCalls).toBe(1));
		releaseVaultExport?.();
		await vi.waitFor(() => expect(vaultExportCalls).toBe(2));
		stopLeaderElection();
		startLeaderElection(OTHER_HASH, () => {});
		releaseVaultExport?.();

		await expect(call).rejects.toThrow(SessionFencedError);
		expect(enqueueIntentCalls).toBe(1);
	});

	it('refuses internally when the token account does not match the row\'s own sender_hash — never trusts the caller alone', async () => {
		const token = pinActiveSession(MY_HASH, 'test:start');

		await expect(ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, OTHER_HASH, token)).rejects.toThrow(SessionFencedError);
		expect(enqueueIntentCalls).toBe(0);
	});

	it('with no switch at all, the same two awaits complete normally and the key is durably published', async () => {
		vaultExportDeferred = true;
		cardsPreloadDeferred = true;
		const token = pinActiveSession(MY_HASH, 'test:start');

		const call = ensureOwnDialogKeyPublished(PEER_HASH, DIALOG_HASH, MY_HASH, token);
		await vi.waitFor(() => expect(vaultExportCalls).toBe(1));
		releaseVaultExport?.();
		await vi.waitFor(() => expect(cardsPreloadCalls).toBe(1));
		releaseCardsPreload?.();
		await vi.waitFor(() => expect(vaultExportCalls).toBe(2));
		releaseVaultExport?.();

		await expect(call).rejects.toThrow();
		expect(wrapSenderMsgKeyCalls).toBe(1);
		expect(enqueueIntentCalls).toBe(1);
		expect(currentSessionToken()).toEqual(token);
	});
});
