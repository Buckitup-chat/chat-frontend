// @vitest-environment jsdom
// The owner's backup is watched for live rounds, and the veto goes out the way
// the backup pays (plan § 7.4). The backup's secret is read from its slot once
// and kept; the chain is asked about the round first, and about the secret
// only while a round is live.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { reactive, nextTick } from 'vue';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';

const OWNER = 'u_' + 'a'.repeat(128);
const ID = '0x' + 'ab'.repeat(32);
const user = { currentUserHash: OWNER };
const H = vi.hoisted(() => ({ slotReads: 0, chain: { secretReads: 0, stateReads: 0 }, revoked: false, gate: null }));
let slot = null;
let chainState = RoundState.Voting;
const calls = [];
const backupStore = reactive({ run: null });

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/recoveryBackup.store', () => ({ BACKUP_SLOT: 'recovery_backup', useRecoveryBackupStore: () => backupStore }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async (name) => (H.slotReads++, name === 'recovery_backup' ? slot : null),
			exportVaultKeys: async () => ({ evm_skey: '0c'.repeat(32) }),
		}),
	},
}));
vi.mock('@/lib/recovery/deployments', () => ({ maybeRecoveryDeployment: () => ({ chainId: 11155111, relayerUrl: 'https://relay.example' }) }));
vi.mock('@/lib/recovery/chain', async (orig) => ({
	...(await orig()),
	RecoveryChain: class {
		readSecret = async () => (H.chain.secretReads++, { revoked: H.revoked, recoveryRound: 4n, executeAfter: 0n, recoveryWindow: 3600n, recoveryRecipient: '0x' + '00'.repeat(20) });
		// The state as the chain had it when asked, answered once the gate opens.
		roundState = async () => {
			H.chain.stateReads++;
			const state = chainState;
			if (H.gate) await H.gate;
			return state;
		};
	},
}));
vi.mock('@/lib/recovery/typedData', () => ({
	signBound: async (_chain, key, type, id) => {
		calls.push({ sign: type, id, key });
		return { body: { id, signer: '0x1', deadline: 1n, signature: '0xsig' } };
	},
}));
// The choice of gateway is gatewayOf's (tested on its own): here, what the store hands it.
vi.mock('@/lib/recovery/gateway', () => ({
	gatewayOf: (_c, fee, _key, fallback) => ({
		cancelRecovery: async (b) => (calls.push({ via: fee?.kind === 'self' ? 'self' : `relayer:${fee?.url || fallback}`, body: b }), (chainState = RoundState.None), { status: 'PROCESSED' }),
	}),
}));

const { useRecoveryRoundsStore } = await import('@/store/recoveryRounds.store');
const RecoveryAlertBanner = (await import('@/components/RecoveryAlertBanner.vue')).default;

let store;
beforeEach(() => {
	setActivePinia(createPinia());
	slot = { run: { secretId: ID, step: 'done', fee: { kind: 'relayer' } } };
	backupStore.run = null;
	chainState = RoundState.Voting;
	H.revoked = false;
	H.gate = null;
	H.slotReads = 0;
	H.chain.secretReads = 0;
	H.chain.stateReads = 0;
	calls.length = 0;
	localStorage.clear();
});
afterEach(() => store?.stopWatching());

const started = async () => {
	store = useRecoveryRoundsStore();
	await store.check();
	return store;
};

describe('watching the owner’s backup', () => {
	it('shows a live round, and nothing before the backup is registered or once it is revoked', async () => {
		slot = { run: { secretId: ID, step: 'submitted' } };
		const s = await started();
		expect(s.shown).toBeNull();
		slot = { run: { secretId: ID, step: 'done', fee: { kind: 'relayer' } } };
		await s.check({ fresh: true });
		expect(s.shown).toMatchObject({ secretId: ID, round: 4, phase: 'voting' });
		H.revoked = true;
		await s.check({ fresh: true });
		expect(s.shown).toBeNull();
	});

	it('reads the slot once, and the secret only while a round is live', async () => {
		chainState = RoundState.None;
		const s = await started();
		await s.check({ fresh: true });
		await s.check({ fresh: true });
		expect(H.slotReads).toBe(1);
		expect(H.chain.stateReads).toBe(3);
		expect(H.chain.secretReads).toBe(0);
		chainState = RoundState.TimeLock;
		await s.check({ fresh: true });
		expect(H.chain.secretReads).toBe(1);
		expect(H.slotReads).toBe(1);
	});

	it('reads the slot again when the backup changes here, and keeps watching the record during a reshare', async () => {
		const s = await started();
		expect(H.slotReads).toBe(1);
		slot = { run: { secretId: ID, step: 'done', fee: { kind: 'self' } }, reshare: { secretId: ID, step: 'submitted', reshareOf: { secretId: ID, version: 1 } } };
		backupStore.run = { secretId: ID, step: 'done', revokedAt: undefined, fee: { kind: 'self' } };
		await nextTick();
		await s.check();
		expect(H.slotReads).toBe(2);
		expect(s.shown).toMatchObject({ secretId: ID });
		await s.stop(s.shown);
		expect(calls.at(-1)).toMatchObject({ via: 'self' });
		backupStore.run = { secretId: ID, step: 'done', revokedAt: 9 };
		slot = { run: { secretId: ID, step: 'done', revokedAt: 9 } };
		await nextTick();
		await s.check();
		expect(s.shown).toBeNull();
	});

	it('stops the round through the free service, without reading the slot again, and shows the round gone', async () => {
		const s = await started();
		await s.stop(s.shown);
		expect(calls).toEqual([
			{ sign: 'CancelRecovery', id: ID, key: '0x' + '0c'.repeat(32) },
			expect.objectContaining({ via: 'relayer:https://relay.example' }),
		]);
		expect(H.slotReads).toBe(1);
		expect(s.shown).toBeNull();
	});

	it('after a stop, checks afresh even while an older check is still in flight', async () => {
		const s = await started();
		let release;
		H.gate = new Promise((r) => (release = r));
		const older = s.check({ fresh: true }); // asks while the round is live, answered late
		await Promise.resolve();
		const stopping = s.stop(s.shown); // the veto ends the round meanwhile
		await new Promise((r) => setTimeout(r, 0));
		H.gate = null;
		release();
		await Promise.all([older, stopping]);
		expect(s.shown).toBeNull();
	});

	it('hides a round the owner says is theirs, on this device, for that round only', async () => {
		const s = await started();
		s.acknowledge(s.shown);
		expect(s.shown).toBeNull();
		expect(JSON.parse(localStorage.getItem(`buckitup:recovery-ack:${OWNER}`))).toEqual({ [ID]: 4 });
	});
});

describe('polling', () => {
	it('checks only while the app is shown, and not again on a return within half a minute', async () => {
		vi.useFakeTimers();
		const visibility = vi.spyOn(document, 'visibilityState', 'get');
		try {
			visibility.mockReturnValue('visible');
			store = useRecoveryRoundsStore();
			await vi.advanceTimersByTimeAsync(0);
			const first = H.chain.stateReads;
			document.dispatchEvent(new Event('visibilitychange'));
			await vi.advanceTimersByTimeAsync(0);
			expect(H.chain.stateReads).toBe(first);
			await vi.advanceTimersByTimeAsync(31_000);
			document.dispatchEvent(new Event('visibilitychange'));
			await vi.advanceTimersByTimeAsync(0);
			expect(H.chain.stateReads).toBe(first + 1);

			visibility.mockReturnValue('hidden');
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(H.chain.stateReads).toBe(first + 1);
			visibility.mockReturnValue('visible');
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(H.chain.stateReads).toBe(first + 2);
		} finally {
			visibility.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe('the banner', () => {
	it('offers Stop it, and It’s me only after a second confirmation', async () => {
		const s = await started();
		const fire = vi.fn(async () => ({ isConfirmed: false }));
		const w = mount(RecoveryAlertBanner, { global: { provide: { $swal: { fire } } } });
		expect(w.text()).toContain('Someone started recovering your account');
		await w.findAll('button')[1].trigger('click');
		await Promise.resolve();
		expect(fire).toHaveBeenCalled();
		expect(s.shown).not.toBeNull();
		await w.findAll('button')[0].trigger('click');
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.some((c) => c.sign === 'CancelRecovery')).toBe(true);
		w.unmount();
	});

	it('never hides a round without the owner confirming it', async () => {
		const s = await started();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errors = [];
		const w = mount(RecoveryAlertBanner, { global: { config: { errorHandler: (e) => errors.push(e) } } });
		await w.findAll('button')[1].trigger('click');
		await new Promise((r) => setTimeout(r, 0));
		expect(s.shown).not.toBeNull();
		w.unmount();
	});

	it('ticks its countdown only while a round is shown', async () => {
		vi.useFakeTimers();
		try {
			chainState = RoundState.None;
			store = useRecoveryRoundsStore();
			await vi.advanceTimersByTimeAsync(0);
			const w = mount(RecoveryAlertBanner, { global: { provide: { $swal: { fire: vi.fn() } } } });
			expect(vi.getTimerCount()).toBe(1); // the store's poll, no countdown
			chainState = RoundState.Voting;
			await store.check({ fresh: true });
			await nextTick();
			expect(vi.getTimerCount()).toBe(2);
			chainState = RoundState.None;
			await store.check({ fresh: true });
			await nextTick();
			expect(vi.getTimerCount()).toBe(1);
			w.unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});
