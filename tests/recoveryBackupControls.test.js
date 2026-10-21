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
	publishRecoveryVault: vi.fn(async () => 'vault-uuid'),
	retireRecoveryVaults: vi.fn(async () => {}),
};
const user = { currentUserHash: OWNER, contacts: [], contactsMap: {} };
const sendMessage = vi.fn(async () => 'dmsg_spare');
const H = vi.hoisted(() => ({ onSign: null, relayerUrl: 'https://relay.example', server: null, holdingOf: null, knownNodes: null }));

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

// The notification server, as a list of subscriptions it keeps.
vi.mock('@/lib/recovery/alerts', async (orig) => ({
	...(await orig()),
	listSubscriptions: async () => (H.server.lists++, H.server.subs.map((x) => ({ ...x }))),
	unsubscribe: async (_b, _k, id) => {
		H.server.subs = H.server.subs.filter((x) => x.id !== id);
	},
	subscribeWebhook: async () => {
		H.server.subs.push({ id: 'w' + H.server.subs.length, kind: 'webhook', createdAt: 'x' });
		return { id: 'w', secret: 'sec' };
	},
}));
vi.mock('@/lib/recovery/nodeClient', async (orig) => ({ ...(await orig()), holdingOf: (...a) => H.holdingOf(...a) }));
vi.mock('@/lib/recovery/nodeDirectory', async (orig) => ({ ...(await orig()), knownNodes: (...a) => H.knownNodes(...a) }));

const { useRecoveryBackupStore, runLockName, recordLockName } = await import('@/store/recoveryBackup.store');
const { secretRefIn } = await import('@/lib/recovery/deployments');
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
	H.server = { subs: [], lists: 0 };
	em.patchSlotJson.mockImplementation(async (name, patch) => (slots[name] = { ...(slots[name] ?? {}), ...patch }));
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
		// Every vault goes, the current one too: nothing is left to read.
		expect(em.retireRecoveryVaults).toHaveBeenCalledWith();
		await expect(store.setPolicy({ delaySec: 86400, windowSec: 86400 })).rejects.toThrow(/revoked/);
	});

	it('says so and keeps the copy to remove when the old vault could not be removed after the revoke, then removes it on the next read', async () => {
		em.retireRecoveryVaults.mockClear();
		em.retireRecoveryVaults.mockRejectedValueOnce(new Error('tombstone refused'));
		const store = await loaded(done());
		await expect(store.revoke()).rejects.toThrow(/revoked, but an old copy of it is still on the server/);
		expect(slots.recovery_backup.run).toMatchObject({ revokedAt: expect.any(Number), retirePending: true });

		setActivePinia(createPinia());
		const again = useRecoveryBackupStore();
		await again.load();
		await vi.waitFor(() => expect(slots.recovery_backup.run.retirePending).toBe(false));
		expect(em.retireRecoveryVaults).toHaveBeenCalledTimes(2);
		// Removed: reading it again tries nothing.
		await useRecoveryBackupStore().load();
		expect(em.retireRecoveryVaults).toHaveBeenCalledTimes(2);
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

describe('alerts recorded while this tab drives a change', () => {
	it('do not wait for the run, only for another write of the record', async () => {
		slots.recovery_backup = { run: done(), reshare: resharing() };
		const store = useRecoveryBackupStore();
		await store.load();
		let releaseRun;
		const running = navigator.locks.request(runLockName(OWNER), { mode: 'exclusive' }, () => new Promise((r) => (releaseRun = r)));
		await store.setAlerts({ channels: ['app', 'telegram'], skipped: false });
		expect(slots.recovery_backup.run.alerts).toEqual({ channels: ['app', 'telegram'], skipped: false });

		// A write of the record under way — a reshare being promoted — goes first.
		let releaseRecord;
		const writing = navigator.locks.request(recordLockName(OWNER), { mode: 'exclusive' }, () => new Promise((r) => (releaseRecord = r)));
		const saved = store.setAlerts({ channels: ['app', 'webhook'], skipped: false });
		await new Promise((r) => setTimeout(r, 0));
		expect(slots.recovery_backup.run.alerts.channels).toEqual(['app', 'telegram']);
		releaseRecord();
		await saved;
		expect(slots.recovery_backup.run.alerts.channels).toEqual(['app', 'webhook']);
		releaseRun();
		await Promise.all([running, writing]);
	});
});

describe('a spare piece', () => {
	it('goes to no guardian who said their piece no longer counts', async () => {
		const record = done({ deployment: 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7', sent: { [U('2')]: { messageId: 'm2', shareIndex: 2 } } });
		const store = await loaded(record);
		store.noteGuardianMessages(U('2'), [
			{ senderHash: U('2'), parts: [{ kind: 'recovery_holding', secretRef: secretRefIn(record.deployment, ID), version: 2, splitId: record.splitId, shareIndex: 2, state: 'given_back', detail: '' }] },
		]);
		expect(store.receipts[U('2')]).toBe('given_back');
		await expect(store.giveSpare(U('2'))).rejects.toThrow('no longer keeps their piece');
		expect(sendMessage).not.toHaveBeenCalled();
		await store.giveSpare(U('3'));
		expect(sendMessage).toHaveBeenCalledTimes(1);
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

describe('alert channels', () => {
	it('are listed once, and again only when a screen asks anew or a channel is added', async () => {
		H.server.subs = [{ id: 't1', kind: 'telegram', createdAt: 'x' }];
		const store = await loaded(done({ alerts: { channels: ['app', 'telegram'], skipped: false } }));
		const [a, b] = await Promise.all([store.subscriptions(), store.subscriptions()]);
		expect(a).toEqual(b);
		await store.subscriptions();
		expect(H.server.lists).toBe(1);
		expect(store.subs.map((x) => x.kind)).toEqual(['telegram']);

		store.staleSubscriptions();
		await store.subscriptions();
		expect(H.server.lists).toBe(2);

		await store.addWebhook('https://hook.example/x');
		expect(H.server.lists).toBe(3);
		expect(store.subs.map((x) => x.kind)).toEqual(['telegram', 'webhook']);
		// The record follows what the server lists.
		expect(slots.recovery_backup.run.alerts).toEqual({ channels: ['app', 'telegram', 'webhook'], skipped: false });
	});

	it('removing one lists them again and records what is left on the backup', async () => {
		H.server.subs = [{ id: 't1', kind: 'telegram', createdAt: 'x' }, { id: 'w1', kind: 'webhook', createdAt: 'x' }];
		const store = await loaded(done({ alerts: { channels: ['app', 'telegram', 'webhook'], skipped: false } }));
		await store.subscriptions();
		const left = await store.removeSubscription('t1');
		expect(H.server.lists).toBe(2);
		expect(left.map((x) => x.id)).toEqual(['w1']);
		expect(store.subs.map((x) => x.id)).toEqual(['w1']);
		expect(slots.recovery_backup.run.alerts).toEqual({ channels: ['app', 'webhook'], skipped: false });
	});

	it('a record that could not be written after a removal is made good by the next list', async () => {
		H.server.subs = [{ id: 't1', kind: 'telegram', createdAt: 'x' }];
		const store = await loaded(done({ alerts: { channels: ['app', 'telegram'], skipped: false } }));
		em.patchSlotJson.mockImplementationOnce(async () => {
			throw new Error('offline');
		});
		await store.removeSubscription('t1');
		expect(H.server.subs).toEqual([]);
		expect(slots.recovery_backup.run.alerts.channels).toEqual(['app', 'telegram']);

		await store.subscriptions({ refresh: true });
		expect(slots.recovery_backup.run.alerts).toEqual({ channels: ['app'], skipped: false });
	});
});

describe('the nodes’ holdings', () => {
	it('are each node’s answer: the backup’s version holds, none or another is lost, no answer is not answering', async () => {
		const record = done({ skippedNodes: ['n_' + 'd'.repeat(32)] });
		record.nodes.push({ id: 'n_' + 'd'.repeat(32), url: 'https://d.example/recovery/node' });
		const store = await loaded(record);
		const asked = [];
		H.holdingOf = async (node, id) => {
			asked.push([node.id, id]);
			if (node.url.startsWith('https://a.')) return 2;
			if (node.url.startsWith('https://b.')) return 1;
			throw new Error('does not answer');
		};
		await store.checkHoldings();
		expect(asked).toEqual(record.nodes.slice(0, 3).map((n) => [n.id, ID]));
		expect(store.holdings).toMatchObject({ runId: 'r1', byNode: { [record.nodes[0].id]: 'holds', [record.nodes[1].id]: 'lost', [record.nodes[2].id]: 'unreachable' } });

		// Checked this recently, a check is not made again unless forced.
		H.holdingOf = async () => null;
		await store.checkHoldings();
		expect(Object.values(store.holdings.byNode)).toEqual(['holds', 'lost', 'unreachable']);
		await store.checkHoldings({ force: true });
		expect(Object.values(store.holdings.byNode)).toEqual(['lost', 'lost', 'lost']);
	});

	it('count a newer version as held, and judge none lost while a reshare is being made', async () => {
		slots.recovery_backup = { run: done(), reshare: resharing() };
		const store = useRecoveryBackupStore();
		await store.load();
		H.holdingOf = async (node) => (node.url.startsWith('https://a.') ? 3 : node.url.startsWith('https://b.') ? 1 : null);
		await store.checkHoldings();
		expect(Object.values(store.holdings.byNode)).toEqual(['holds', 'changing', 'changing']);
	});

	it('are not asked of a revoked backup', async () => {
		const store = await loaded(done({ revokedAt: 5 }));
		H.holdingOf = vi.fn();
		await store.checkHoldings();
		expect(H.holdingOf).not.toHaveBeenCalled();
	});
});

describe('reads made at once', () => {
	it('share a read of the backup only within one account', async () => {
		slots.recovery_backup = { run: done() };
		const store = useRecoveryBackupStore();
		em.loadSlotJson.mockClear();
		const first = store.load();
		user.currentUserHash = U('9');
		const second = store.load();
		await Promise.all([first, second]);
		expect(em.loadSlotJson.mock.calls.filter(([name]) => name === 'recovery_backup')).toHaveLength(2);
		expect(store.loaded).toBe(true);
	});

	it('share one read of the backup, and one check of the nodes', async () => {
		slots.recovery_backup = { run: done() };
		const store = useRecoveryBackupStore();
		em.loadSlotJson.mockClear();
		await Promise.all([store.load(), store.load()]);
		expect(em.loadSlotJson.mock.calls.filter(([name]) => name === 'recovery_backup')).toHaveLength(1);

		let checks = 0;
		H.knownNodes = async () => (checks++, { nodes: [], refused: {} });
		await Promise.all([store.refreshNodes(), store.refreshNodes()]);
		expect(checks).toBe(1);
		await store.refreshNodes();
		expect(checks).toBe(2);
	});
});
