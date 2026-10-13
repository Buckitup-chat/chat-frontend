// @vitest-environment jsdom
// Changing a finished backup (plan § 7.4, Controls): the waiting period and
// the time to finish, revocation for good, and a spare piece handed to an
// existing guardian — each signed by the owner and sent the way the backup pays.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const OWNER = 'u_' + 'a'.repeat(128);
const U = (c) => 'u_' + c.repeat(128);
const ID = '0x' + 'ab'.repeat(32);
const slots = {};
const calls = [];
const em = {
	loadSlotJson: vi.fn(async (name) => slots[name] ?? null),
	patchSlotJson: vi.fn(async (name, patch) => (slots[name] = { ...(slots[name] ?? {}), ...patch })),
	exportVaultKeys: vi.fn(async () => ({ evm_skey: '11'.repeat(32) })),
};
const user = { currentUserHash: OWNER, contacts: [], contactsMap: {} };
const sendMessage = vi.fn(async () => 'dmsg_spare');
const H = vi.hoisted(() => ({ onSign: null, relayerUrl: 'https://relay.example' }));

vi.mock('@/lib/recovery/chain', () => ({ RecoveryChain: class {} }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ sendMessage }) }));
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => ({ roster: {}, deployment: null, load: async () => {} }) }));
vi.mock('@/lib/recovery/deployments', async (orig) => ({
	...(await orig()),
	maybeRecoveryDeployment: () => ({ chainId: 11155111, secretRecovery: '0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7', relayerUrl: H.relayerUrl }),
}));
vi.mock('@/lib/recovery/typedData', async (orig) => ({
	...(await orig()),
	signBound: async (_c, key, type, id, fields) => (calls.push({ sign: type, id, fields }), H.onSign?.(), { body: { id, ...fields, signer: '0x1', deadline: 1n, signature: '0xs' } }),
}));
const gateway = (via) =>
	new Proxy({}, { get: (_t, name) => async (body) => (calls.push({ via, call: name, body }), { status: 'PROCESSED' }) });
// The choice of gateway is gatewayOf's (tested on its own): here, what the store hands it.
vi.mock('@/lib/recovery/gateway', () => ({ gatewayOf: (_c, fee, _k, fallback) => gateway(fee?.kind === 'self' ? 'self' : `relayer:${fee?.url || fallback}`) }));

const { useRecoveryBackupStore } = await import('@/store/recoveryBackup.store');
const { defaultSettings } = await import('@/lib/recovery/backupPlan');

const guardians = [U('1'), U('2'), U('3')].map((userHash) => ({ userHash, metaAddress: 'st:eth:0x00' }));
const done = (over = {}) => ({
	runId: 'r1', label: 'bu-1', owner: '0x' + '2'.repeat(40), guardians, settings: defaultSettings(3, 3),
	nodes: ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` })),
	step: 'done', wrapKey: '00'.repeat(32), splitId: '11'.repeat(16), shares: [null, null, null, 'U1BBUkU0', 'U1BBUkU1'], leaves: ['a', 'b', 'c', 'd', 'e'],
	root: '00'.repeat(64), nodeShares: [], nodeOutcomes: {}, skippedNodes: [], sent: {}, startedAt: 1, updatedAt: 1, device: 'd',
	secretId: ID, version: 2, fee: { kind: 'relayer' }, ...over,
});

beforeEach(async () => {
	setActivePinia(createPinia());
	for (const k of Object.keys(slots)) delete slots[k];
	calls.length = 0;
	sendMessage.mockClear();
	sendMessage.mockImplementation(async () => 'dmsg_spare');
	user.currentUserHash = OWNER;
	H.onSign = null;
	H.relayerUrl = 'https://relay.example';
	Object.defineProperty(navigator, 'locks', { value: makeFakeLockManager(), configurable: true });
});

const loaded = async (run) => {
	slots.recovery_backup = { run };
	const store = useRecoveryBackupStore();
	await store.load();
	return store;
};

describe('changing a finished backup', () => {
	it('changes the wait and the time to finish on chain, then in the record; refuses times out of bounds', async () => {
		const store = await loaded(done());
		await store.setPolicy({ delaySec: 86400, windowSec: 2 * 86400 });
		expect(calls).toEqual([
			{ sign: 'SetRecoveryPolicy', id: ID, fields: { recoveryDelay: 86400n, recoveryWindow: 172800n } },
			expect.objectContaining({ via: 'relayer:https://relay.example', call: 'setRecoveryPolicy' }),
		]);
		expect(slots.recovery_backup.run.settings).toMatchObject({ delaySec: 86400, windowSec: 172800 });
		await expect(store.setPolicy({ delaySec: 60, windowSec: 2 * 86400 })).rejects.toThrow(/delaySec/);
	});

	it('revokes for good, from the owner’s own address when the backup pays itself, and then refuses further changes', async () => {
		const store = await loaded(done({ fee: { kind: 'self' } }));
		await store.revoke();
		expect(calls).toEqual([{ sign: 'RevokeSecret', id: ID, fields: {} }, expect.objectContaining({ via: 'self', call: 'revokeSecret' })]);
		expect(slots.recovery_backup.run.revokedAt).toBeGreaterThan(0);
		await expect(store.setPolicy({ delaySec: 86400, windowSec: 86400 })).rejects.toThrow(/revoked/);
	});

	it('hands a spare piece to a guardian of the backup, once, and to nobody else', async () => {
		const store = await loaded(done());
		await expect(store.giveSpare(U('9'))).rejects.toThrow(/only to a guardian/);
		await store.giveSpare(U('2'));
		const [peer, [part]] = sendMessage.mock.calls[0];
		expect(peer).toBe(U('2'));
		expect(part).toMatchObject({ kind: 'recovery_share', shareIndex: 4, shareB64: 'U1BBUkU0', version: 2, secretRef: expect.stringContaining(ID) });
		expect(slots.recovery_backup.run.shares[3]).toBeNull();
		expect(slots.recovery_backup.run.sparesGiven).toEqual({ 4: { guardian: U('2'), messageId: 'dmsg_spare' } });
		await store.giveSpare(U('3'));
		await expect(store.giveSpare(U('1'))).rejects.toThrow(/No spare/);
	});

	it('refuses with no finished backup', async () => {
		const store = await loaded(done({ step: 'registered' }));
		await expect(store.revoke()).rejects.toThrow(/no finished backup/);
	});

	it('act on the record as the slot holds it, not on this tab’s copy', async () => {
		const store = await loaded(done());
		// Another tab revoked since.
		slots.recovery_backup = { run: done({ revokedAt: 9 }) };
		await expect(store.setPolicy({ delaySec: 86400, windowSec: 2 * 86400 })).rejects.toThrow(/revoked/);
		await expect(store.giveSpare(U('2'))).rejects.toThrow(/revoked/);
		expect(calls).toEqual([]);
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe('two tabs', () => {
	it('never hand out the same spare', async () => {
		const a = await loaded(done());
		setActivePinia(createPinia());
		const b = useRecoveryBackupStore();
		await b.load();
		await a.giveSpare(U('2'));
		await b.giveSpare(U('3'));
		expect(sendMessage.mock.calls.map(([peer, [part]]) => [peer, part.shareIndex])).toEqual([[U('2'), 4], [U('3'), 5]]);
		expect(slots.recovery_backup.run.sparesGiven).toEqual({ 4: { guardian: U('2'), messageId: 'dmsg_spare' }, 5: { guardian: U('3'), messageId: 'dmsg_spare' } });
	});

	it('refuse a change while another tab holds the backup', async () => {
		const store = await loaded(done());
		let release;
		const other = navigator.locks.request('buckitup:backup-run:' + OWNER, () => new Promise((r) => (release = r)));
		await new Promise((r) => setTimeout(r, 0));
		await expect(store.revoke()).rejects.toThrow(/another tab/);
		release();
		await other;
		expect(calls).toEqual([]);
	});
});

const resharing = (over = {}) => done({ runId: 'r2', step: 'published', version: undefined, reshareOf: { secretId: ID, version: 2 }, ...over });

describe('while a reshare is being made', () => {
	it('refuses to revoke, change the times or hand out a spare, and still records alerts', async () => {
		slots.recovery_backup = { run: done(), reshare: resharing() };
		const store = useRecoveryBackupStore();
		await store.load();
		for (const act of [() => store.revoke(), () => store.setPolicy({ delaySec: 86400, windowSec: 86400 }), () => store.giveSpare(U('2'))]) {
			await expect(act()).rejects.toThrow('finish or discard the change first');
		}
		expect(calls).toEqual([]);
		expect(sendMessage).not.toHaveBeenCalled();
		await store.setAlerts({ channels: ['app', 'telegram'], skipped: false });
		expect(slots.recovery_backup.run.alerts).toEqual({ channels: ['app', 'telegram'], skipped: false });
		expect(slots.recovery_backup.reshare.runId).toBe('r2');
	});
});

describe('another account signed in during a change', () => {
	it('sends and writes nothing more for the one that started it', async () => {
		const store = await loaded(done());
		H.onSign = () => (user.currentUserHash = U('z'));
		await store.revoke();
		expect(calls.map((c) => c.sign ?? c.call)).toEqual(['RevokeSecret']);
		expect(slots.recovery_backup.run.revokedAt).toBeUndefined();

		user.currentUserHash = OWNER;
		H.onSign = null;
		sendMessage.mockImplementation(async () => ((user.currentUserHash = U('z')), 'dmsg_spare'));
		await store.giveSpare(U('2'));
		expect(slots.recovery_backup.run.shares[3]).toBe('U1BBUkU0');
	});
});

describe('a change written onto the record as it is', () => {
	it('keeps what another device wrote while a spare was on its way', async () => {
		const store = await loaded(done());
		sendMessage.mockImplementation(async () => {
			slots.recovery_backup = { run: { ...slots.recovery_backup.run, alerts: { channels: ['app', 'webhook'], skipped: false } } };
			return 'dmsg_spare';
		});
		await store.giveSpare(U('2'));
		expect(slots.recovery_backup.run).toMatchObject({ alerts: { channels: ['app', 'webhook'], skipped: false }, sparesGiven: { 4: { guardian: U('2') } } });
		expect(slots.recovery_backup.run.shares[3]).toBeNull();
	});
});

describe('alert subscriptions', () => {
	it('say clearly that a network without a notification server has none to remove', async () => {
		H.relayerUrl = null;
		const store = await loaded(done());
		await expect(store.removeSubscription('s1')).rejects.toThrow('This network has no notification server.');
		expect(await store.history()).toEqual([]);
	});
});
