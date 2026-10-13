// @vitest-environment jsdom
// The owner's side of § Holding: each guardian's latest word on the piece
// they were sent becomes the run's receipt — stored counts, the kept-with-a-
// problem states are one problem, a delivered receipt says only that it
// arrived — read from each guardian's dialog, for this run only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { isReportOn, latestReport, receiptOf, sentSharesOf } from '@/lib/recovery/receipts';

const NS = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const ID = '0x' + 'AB'.repeat(32);
const OWNER = 'u_' + 'o'.repeat(128);
const G = (c) => 'u_' + c.repeat(128);

const run = (over = {}) => ({
	runId: 'r1',
	deployment: NS,
	secretId: ID,
	version: 2,
	splitId: 'split-1',
	step: 'done',
	guardians: [G('a'), G('b'), G('c')].map((userHash) => ({ userHash, metaAddress: 'x' })),
	settings: { threshold: 2, approvals: 2, spares: 2, delaySec: 1, windowSec: 1, nodeThreshold: 2 },
	sent: { [G('a')]: { messageId: 'ma', shareIndex: 1 }, [G('b')]: { messageId: 'mb', shareIndex: 2 }, [G('c')]: { messageId: 'mc', shareIndex: 3 } },
	...over,
});
const word = (state, over = {}) => ({ kind: 'recovery_holding', secretRef: `${NS}/${ID.toLowerCase()}`, version: 2, splitId: 'split-1', shareIndex: 1, state, detail: state === 'stored' ? '' : 'why', ...over });

describe('receiptOf', () => {
	const sent = sentSharesOf(run());

	it('names each share as the reports do: the secret ref in its canonical form', () => {
		expect(sent[G('a')]).toEqual({ secretRef: `${NS}/${ID.toLowerCase()}`, version: 2, splitId: 'split-1', shareIndex: 1, messageId: 'ma' });
		expect(sentSharesOf(run({ secretId: undefined }))).toEqual({});
	});

	it('maps the guardian’s latest word: stored, problem, given back, dropped', () => {
		const read = (...parts) => ({ messages: parts.map((p) => ({ senderHash: G('a'), parts: [p] })), delivered: [] });
		expect(receiptOf(G('a'), sent[G('a')], read(word('stored')))).toEqual({ state: 'stored', detail: '' });
		for (const s of ['unverified', 'unreachable', 'unrequested']) {
			expect(receiptOf(G('a'), sent[G('a')], read(word('stored'), word(s)))).toEqual({ state: 'problem', detail: 'why' });
		}
		expect(receiptOf(G('a'), sent[G('a')], read(word('given_back')))).toMatchObject({ state: 'given_back' });
		expect(receiptOf(G('a'), sent[G('a')], read(word('dropped')))).toMatchObject({ state: 'dropped' });
		// About another piece, or another version: not this one's word.
		expect(receiptOf(G('a'), sent[G('a')], read(word('stored', { shareIndex: 2 }), word('stored', { version: 1 })))).toBeNull();
	});

	it('reads only the guardian’s own word about the share they were sent, latest last', () => {
		const msgs = [
			{ senderHash: G('a'), parts: [word('stored')] },
			{ senderHash: G('b'), parts: [word('given_back')] }, // not the guardian it went to
			{ senderHash: G('a'), parts: [word('stored', { shareIndex: 2 })] }, // another share
			{ senderHash: G('a'), parts: [word('given_back')] },
			{ senderHash: G('a'), parts: [word('whatever')] }, // a state the owner does not read
		];
		expect(latestReport(msgs, G('a'), sent[G('a')])).toEqual({ state: 'given_back', detail: 'why' });
		expect(latestReport(msgs, G('c'), sent[G('a')])).toBeNull();
		expect(isReportOn(sent[G('a')])(word('whatever'))).toBe(false);
		expect(isReportOn(sent[G('a')])(word('stored'))).toBe(true);
	});

	it('falls back to delivered when the dialog says the piece arrived, and to nothing otherwise', () => {
		expect(receiptOf(G('a'), sent[G('a')], { messages: [], delivered: ['ma'] })).toEqual({ state: 'delivered', detail: '' });
		expect(receiptOf(G('a'), sent[G('a')], { messages: [], delivered: ['mb'] })).toBeNull();
	});
});

const slots = {};
const em = { loadSlotJson: vi.fn(async (name) => slots[name] ?? null), patchSlotJson: vi.fn() };
const user = { currentUserHash: OWNER, contacts: [], contactsMap: {} };
// The dialogs as readPeerParts answers: each guardian's own messages, or null for a dialog that cannot be read now.
const dialogs = {};
const readPeerParts = vi.fn(async (peer) => dialogs[peer] ?? null);
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ sendMessage: vi.fn(), readPeerParts }) }));
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => ({ roster: {}, deployment: null, load: async () => {} }) }));
vi.mock('@/lib/recovery/chain', () => ({ RecoveryChain: class {} }));

const { useRecoveryBackupStore } = await import('@/store/recoveryBackup.store');

describe('the backup store’s receipts', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		user.currentUserHash = OWNER;
		slots.recovery_backup = { run: run() };
		for (const k of Object.keys(dialogs)) delete dialogs[k];
		readPeerParts.mockClear();
		Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
	});

	it('reads each guardian’s dialog and keeps what each said, a dialog that cannot be read keeping nothing', async () => {
		dialogs[G('a')] = { messages: [{ senderHash: G('a'), parts: [word('stored')] }], delivered: ['ma'] };
		dialogs[G('b')] = { messages: [{ senderHash: G('b'), parts: [word('given_back', { shareIndex: 2 })] }], delivered: [] };
		const store = useRecoveryBackupStore();
		await store.refreshReceipts();
		expect(readPeerParts.mock.calls.map(([peer, kinds, o]) => [peer, kinds, o.deliveredOf, o.newestMatch(word('stored', { shareIndex: o.deliveredOf[0] === 'ma' ? 1 : 9 }))])).toEqual([
			[G('a'), ['recovery_holding'], ['ma'], true],
			[G('b'), ['recovery_holding'], ['mb'], false],
			[G('c'), ['recovery_holding'], ['mc'], false],
		]);
		expect(store.receipts).toEqual({ [G('a')]: 'stored', [G('b')]: 'given_back' });
		expect(store.receiptDetails[G('b')]).toEqual({ state: 'given_back', detail: 'why' });

		// Heard a moment ago: not read again; a dialog that could not be read is.
		readPeerParts.mockClear();
		await store.refreshReceipts();
		expect(readPeerParts.mock.calls.map(([peer]) => peer)).toEqual([G('c')]);
		readPeerParts.mockClear();

		// Later, a read that fails keeps what was heard; an unchanged word changes nothing.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 3 * 60_000);
			delete dialogs[G('a')];
			const before = store.receiptDetails;
			await store.refreshReceipts();
			expect(readPeerParts).toHaveBeenCalledTimes(3);
			expect(store.receipts[G('a')]).toBe('stored');
			expect(store.receiptDetails).toBe(before);
		} finally {
			vi.useRealTimers();
		}
	});

	it('takes an open dialog’s messages as they are, and forgets what was heard for another run', async () => {
		const store = useRecoveryBackupStore();
		await store.load();
		store.noteGuardianMessages(G('c'), [{ senderHash: G('c'), parts: [word('unverified', { shareIndex: 3, detail: 'the share does not match its leaf' })] }]);
		expect(store.receiptDetails).toEqual({ [G('c')]: { state: 'problem', detail: 'the share does not match its leaf' } });
		store.noteGuardianMessages(G('z'), [{ senderHash: G('z'), parts: [word('stored')] }]);
		expect(Object.keys(store.receipts)).toEqual([G('c')]);

		store.run = run({ runId: 'r2' });
		expect(store.receipts).toEqual({});
	});
});
