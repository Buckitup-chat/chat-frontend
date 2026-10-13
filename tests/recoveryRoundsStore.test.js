// @vitest-environment jsdom
// The owner's backup is watched for live rounds, and the veto goes out the way
// the backup pays (plan § 7.4).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';

const OWNER = 'u_' + 'a'.repeat(128);
const ID = '0x' + 'ab'.repeat(32);
const user = { currentUserHash: OWNER };
let slot = null;
let chainState = RoundState.Voting;
const calls = [];

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ loadSlotJson: async () => slot, exportVaultKeys: async () => ({ evm_skey: '0c'.repeat(32) }) }) },
}));
vi.mock('@/lib/recovery/deployments', () => ({ maybeRecoveryDeployment: () => ({ chainId: 11155111, relayerUrl: 'https://relay.example' }) }));
vi.mock('@/lib/recovery/chain', () => ({
	RecoveryChain: class {
		readSecret = async () => ({ revoked: false, recoveryRound: 4n, executeAfter: 0n, recoveryWindow: 3600n, recoveryRecipient: '0x' + '00'.repeat(20) });
		roundState = async () => chainState;
	},
}));
vi.mock('@/lib/recovery/typedData', () => ({
	signBound: async (_chain, key, type, id) => {
		calls.push({ sign: type, id, key });
		return { body: { id, signer: '0x1', deadline: 1n, signature: '0xsig' } };
	},
}));
vi.mock('@/lib/recovery/gateway', () => ({
	relayerGateway: (url) => ({ cancelRecovery: async (b) => (calls.push({ via: 'relayer', url, body: b }), chainState = RoundState.None, { status: 'PROCESSED' }) }),
	directGateway: () => ({ cancelRecovery: async (b) => (calls.push({ via: 'self', body: b }), chainState = RoundState.None, { status: 'PROCESSED' }) }),
}));

const { useRecoveryRoundsStore } = await import('@/store/recoveryRounds.store');
const RecoveryAlertBanner = (await import('@/components/RecoveryAlertBanner.vue')).default;

beforeEach(() => {
	setActivePinia(createPinia());
	slot = { run: { secretId: ID, step: 'done', fee: { kind: 'relayer' } } };
	chainState = RoundState.Voting;
	calls.length = 0;
	localStorage.clear();
});

describe('watching the owner’s backup', () => {
	it('shows a live round, and nothing before the backup is registered', async () => {
		const s = useRecoveryRoundsStore();
		await s.check();
		expect(s.shown).toHaveLength(1);
		slot = { run: { secretId: ID, step: 'submitted' } };
		await s.check();
		expect(s.shown).toHaveLength(0);
		s.stopWatching();
	});

	it('stops the round through the free service, or from the owner’s address when the backup pays itself', async () => {
		const s = useRecoveryRoundsStore();
		await s.check();
		await s.stop(s.shown[0]);
		expect(calls).toEqual([
			{ sign: 'CancelRecovery', id: ID, key: '0x' + '0c'.repeat(32) },
			expect.objectContaining({ via: 'relayer', url: 'https://relay.example' }),
		]);
		expect(s.shown).toHaveLength(0);
		chainState = RoundState.TimeLock;
		slot.run.fee = { kind: 'self' };
		await s.check();
		await s.stop(s.shown[0]);
		expect(calls.at(-1)).toMatchObject({ via: 'self' });
		s.stopWatching();
	});

	it('hides a round the owner says is theirs, on this device, for that round only', async () => {
		const s = useRecoveryRoundsStore();
		await s.check();
		s.acknowledge(s.shown[0]);
		expect(s.shown).toHaveLength(0);
		expect(JSON.parse(localStorage.getItem(`buckitup:recovery-ack:${OWNER}`))).toEqual({ [ID]: 4 });
		s.stopWatching();
	});
});

describe('the banner', () => {
	it('offers Stop it, and It’s me only after a second confirmation', async () => {
		const s = useRecoveryRoundsStore();
		await s.check();
		const fire = vi.fn(async () => ({ isConfirmed: false }));
		const w = mount(RecoveryAlertBanner, { global: { provide: { $swal: { fire } } } });
		expect(w.text()).toContain('Someone started recovering your account');
		await w.findAll('button')[1].trigger('click');
		await Promise.resolve();
		expect(fire).toHaveBeenCalled();
		expect(s.shown).toHaveLength(1);
		await w.findAll('button')[0].trigger('click');
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.some((c) => c.sign === 'CancelRecovery')).toBe(true);
		s.stopWatching();
	});
});
