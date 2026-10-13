// A dialog page's backup pieces: only the peer's verified shares are handed
// to the holdings, each share and report gets the view it stands for, the
// peer's word on this account's piece reaches the backup's receipts, and a
// piece is given back only after the prompt is confirmed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, reactive, nextTick } from 'vue';
import { holdingKey } from '@/lib/recovery/holdings';
import { conflictKey } from '@/lib/recovery/keeping';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const REF = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7/0x' + 'ab'.repeat(32);
const env = (over = {}) => ({ secretRef: REF, version: 1, threshold: 2, total: 5, shareB64: 'AAAA', creationUnixtime: 1, splitId: 's1', shareIndex: 1, splitProof: [], nodeSet: null, ...over });
const sharePart = (over) => ({ kind: 'recovery_share', ...env(over) });
const holdingPart = (state, over = {}) => ({ kind: 'recovery_holding', secretRef: REF, version: 1, splitId: 's1', shareIndex: 1, state, detail: '', ...over });

const holdings = reactive({ holdings: {}, receive: vi.fn(async () => {}), giveBack: vi.fn(async () => {}) });
const backup = reactive({
	loaded: true,
	run: { runId: 'r1', deployment: REF.split('/')[0], secretId: '0x' + 'ab'.repeat(32), version: 1, splitId: 's1', sent: { [PEER]: { messageId: 'dmsg_mine', shareIndex: 1 } }, guardians: [] },
	receipts: {},
	receiptDetails: {},
	load: vi.fn(async () => {}),
	noteGuardianMessages: vi.fn(),
});
vi.mock('@/store/recoveryHoldings.store', () => ({ useRecoveryHoldingsStore: () => holdings }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => backup }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUserHash: ME }) }));

const { useRecoveryShares } = await import('@/composables/useRecoveryShares');

let seq = 0;
const msg = (sender, parts, over = {}) => {
	seq += 1;
	const id = over.id ?? `dmsg_${(0x0192aaa0 + seq).toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`;
	return { id, parts, _verify: 'verified', _decrypted: true, _deleted: false, _raw: { message_id: id, sender_hash: sender, owner_timestamp: 1_700_000_000 + seq }, ...over };
};
const flush = async () => { for (let i = 0; i < 4; i++) await nextTick(); };

let swal;
const use = (messages) => useRecoveryShares({ peerHash: ref(PEER), messages: ref(messages), peerName: ref('Daria'), swal, isAlive: () => true });

beforeEach(() => {
	holdings.holdings = {};
	holdings.receive.mockClear();
	holdings.giveBack.mockClear();
	backup.noteGuardianMessages.mockClear();
	backup.receipts = {};
	backup.receiptDetails = {};
	swal = { fire: vi.fn(async () => ({ isConfirmed: true })) };
});

describe('the shares the peer sent', () => {
	it('are handed to the holdings when the dialog opens: verified, live and the peer’s only', async () => {
		const good = msg(PEER, [sharePart()]);
		use([
			good,
			msg(PEER, [sharePart({ shareIndex: 2 })], { _verify: 'invalid' }),
			msg(PEER, [sharePart({ shareIndex: 3 })], { _deleted: true }),
			msg(ME, [sharePart({ shareIndex: 4 })]),
		]);
		await flush();
		expect(holdings.receive).toHaveBeenCalledWith(PEER, [{ messageId: good.id, share: env() }]);
	});

	it('show where each stands: saving until kept, the holding’s state after, a refusal as its own', () => {
		const a = msg(PEER, [sharePart()]);
		const b = msg(PEER, [sharePart({ shareB64: 'BBBB' })]);
		const { views } = use([a, b]);
		expect(views.value[a.id]).toMatchObject({ kind: 'kept_share', state: 'saving', canGiveBack: false });
		holdings.holdings = { [holdingKey(PEER, env())]: { owner: PEER, share: env(), messageId: a.id, state: 'stored', detail: '' } };
		expect(views.value[a.id]).toMatchObject({ state: 'stored', key: holdingKey(PEER, env()), canGiveBack: true, version: 1, shareIndex: 1 });
		// Other bytes under a kept key: not this one's holding — a refusal still being recorded.
		expect(views.value[b.id]).toMatchObject({ state: 'saving' });
		holdings.holdings[conflictKey(PEER, b.id, env({ shareB64: 'BBBB' }))] = { owner: PEER, share: env({ shareB64: '' }), messageId: b.id, state: 'conflict', detail: 'different contents' };
		expect(views.value[b.id]).toMatchObject({ state: 'conflict', detail: 'different contents', canGiveBack: false });
	});
});

describe('this account’s piece and the reports on it', () => {
	it('shows the backup’s receipt on the share it sent, and hands the peer’s reports to the backup in dialog order', async () => {
		const mine = msg(ME, [sharePart()], { id: 'dmsg_mine' });
		const other = msg(ME, [sharePart({ version: 9 })]);
		const later = msg(PEER, [holdingPart('given_back')]);
		// Shown after, written before: dialog order is the authoring time in the id.
		const earlier = msg(PEER, [holdingPart('stored')], { id: 'dmsg_01920000-0000-7000-8000-000000000000' });
		const own = msg(ME, [holdingPart('stored')]);
		backup.receipts = { [PEER]: 'given_back' };
		const { views } = use([mine, other, later, earlier, own]);
		await flush();
		expect(views.value.dmsg_mine).toEqual({ kind: 'sent_share', state: 'given_back', detail: '', version: 1 });
		expect(views.value[other.id]).toMatchObject({ kind: 'sent_share', state: null });
		expect(views.value[later.id]).toEqual({ kind: 'holding', mine: false, state: 'given_back', detail: '' });
		expect(views.value[own.id]).toMatchObject({ kind: 'holding', mine: true, state: 'stored' });
		expect(backup.noteGuardianMessages).toHaveBeenCalledWith(PEER, [
			{ senderHash: PEER, parts: [holdingPart('stored')] },
			{ senderHash: PEER, parts: [holdingPart('given_back')] },
		]);
	});
});

describe('giving back', () => {
	it('asks first, and gives back only on confirmation', async () => {
		const { giveBack } = use([]);
		swal.fire.mockResolvedValueOnce({ isConfirmed: false });
		await giveBack('k1');
		expect(holdings.giveBack).not.toHaveBeenCalled();
		expect(swal.fire.mock.calls[0][0]).toMatchObject({ title: "Give back Daria's backup piece?", confirmButtonText: 'Give back' });
		expect(swal.fire.mock.calls[0][0].text).toContain('still lists you as their guardian');

		await giveBack('k1');
		expect(holdings.giveBack).toHaveBeenCalledWith('k1');
	});

	it('says so when it failed', async () => {
		holdings.giveBack.mockRejectedValueOnce(new Error('offline'));
		const { giveBack } = use([]);
		await giveBack('k1');
		expect(swal.fire).toHaveBeenLastCalledWith(expect.objectContaining({ icon: 'error', title: 'The piece was not given back', text: 'offline' }));
	});
});
