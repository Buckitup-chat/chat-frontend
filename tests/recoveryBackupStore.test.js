// @vitest-environment jsdom
// The backup store drives the account's one run: start is the last gate
// before a registration that cannot be taken back, one tab drives at a time
// from the run as saved, nothing is written under another account, and a run
// another device stopped moving can be continued here — after which that
// device writes nothing more.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const OWNER = 'u_' + 'a'.repeat(128);
const U = (c) => 'u_' + c.repeat(128);

const slots = {};
const em = {
	loadSlotJson: vi.fn(async (name) => slots[name] ?? null),
	patchSlotJson: vi.fn(async (name, patch) => (slots[name] = { ...(slots[name] ?? {}), ...patch })),
	exportVaultKeys: vi.fn(async () => ({ evm_skey: '11'.repeat(32) })),
};
// By default step 2 waits on the account's export: a run started here stays at step 1.
const user = { currentUserHash: OWNER, contacts: [], contactsMap: {}, exportBackup: vi.fn(() => new Promise(() => {})) };
const published = vi.hoisted(() => []);
vi.mock('@/lib/recovery/vault', () => ({ publishVault: async (v) => (published.push(v), 'vault-uuid') }));
// The chain never answers: a run that reaches registration waits there.
vi.mock('@/lib/recovery/chain', () => ({ RecoveryChain: class { readSecret() { return new Promise(() => {}); } } }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ sendMessage: vi.fn() }) }));
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => ({ roster: {}, deployment: null, load: async () => {} }) }));

const { useRecoveryBackupStore } = await import('@/store/recoveryBackup.store');
const { defaultSettings } = await import('@/lib/recovery/backupPlan');

const node = (tag, operator) => {
	const id = 'n_' + tag.repeat(32);
	return {
		descriptor: { id, url: `https://node${tag}.example.org/recovery/node`, chain: 'eip155:11155111', contract: '0x', operator, issued_at: 1, node_pubkey: '', node_sig: '', operator_sig: 's' },
		online: true,
	};
};
const guardians = [U('1'), U('2'), U('3')].map((userHash) => ({ userHash, metaAddress: 'st:eth:0x00' }));
const nodes = [node('1', U('7')), node('2', U('8')), node('3', U('9'))];
const input = (over = {}) => ({
	guardians,
	settings: defaultSettings(3, 3),
	nodes,
	fee: { kind: 'relayer' },
	alerts: { channels: ['app', 'telegram'], skipped: false },
	...over,
});

let lockManager;
beforeEach(() => {
	setActivePinia(createPinia());
	for (const k of Object.keys(slots)) delete slots[k];
	em.patchSlotJson.mockClear();
	user.currentUserHash = OWNER;
	user.exportBackup = vi.fn(() => new Promise(() => {}));
	published.length = 0;
	lockManager = makeFakeLockManager();
	Object.defineProperty(navigator, 'locks', { value: lockManager, configurable: true });
});

const DEVICE = () => localStorage.getItem('buckitup:device-label');
const savedRun = (over = {}) => ({
	runId: 'r1',
	label: 'bu-1',
	owner: '0x' + '2'.repeat(40),
	guardians,
	settings: defaultSettings(3, 3),
	nodes: nodes.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
	step: 'prepared',
	wrapKey: '00'.repeat(32),
	shares: [],
	leaves: [],
	nodeShares: [],
	nodeOutcomes: {},
	skippedNodes: [],
	sent: {},
	startedAt: 1,
	updatedAt: Math.floor(Date.now() / 1000),
	device: DEVICE(),
	fee: { kind: 'relayer' },
	...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('starting a backup', () => {
	it('refuses settings out of bounds before anything is decided or saved', async () => {
		const store = useRecoveryBackupStore();
		await expect(store.start(input({ settings: { ...defaultSettings(3, 3), approvals: 1 } }))).rejects.toThrow(/approvals: below_threshold/);
		await expect(store.start(input({ guardians: guardians.slice(0, 1) }))).rejects.toThrow(/guardians: too_few/);
		await expect(store.start(input({ settings: { ...defaultSettings(3, 3), spares: 11 } }))).rejects.toThrow(/spares: out_of_range/);
		expect(em.patchSlotJson).not.toHaveBeenCalled();
		expect(store.run).toBeNull();
	});

	it('refuses a node set the rules refuse: a guardian\'s node, too few operators', async () => {
		const store = useRecoveryBackupStore();
		await expect(store.start(input({ nodes: [nodes[0], nodes[1], node('4', U('1'))] }))).rejects.toThrow(/refused_node/);
		await expect(store.start(input({ nodes: [nodes[0], node('5', U('7')), nodes[1]] }))).rejects.toThrow(/too_few_operators/);
		expect(em.patchSlotJson).not.toHaveBeenCalled();
	});

	it('resolves once the prepared run is saved, and runs it in the background', async () => {
		const store = useRecoveryBackupStore();
		await store.start(input());
		expect(slots.recovery_backup.run).toMatchObject({ step: 'prepared', fee: { kind: 'relayer' }, alerts: { channels: ['app', 'telegram'], skipped: false } });
		expect(slots.recovery_backup.run.nodes).toEqual(nodes.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })));
		expect(store.run.runId).toBe(slots.recovery_backup.run.runId);
		expect(store.running).toBe(true);
		await expect(store.start(input())).rejects.toThrow('A backup is already being created.');
	});
});

describe('one backup per account', () => {
	it('refuses to start while the account has a backup, even one this tab has not read', async () => {
		const store = useRecoveryBackupStore();
		slots.recovery_backup = { run: savedRun({ step: 'done' }) };
		await expect(store.start(input())).rejects.toThrow('This account already has a backup. Changing it is a reshare.');
		await store.load();
		await expect(store.start(input())).rejects.toThrow('already has a backup');
		expect(em.patchSlotJson).not.toHaveBeenCalled();
	});

	it('changes a finished backup only as a reshare of its secret, at its next version', async () => {
		const store = useRecoveryBackupStore();
		await expect(store.start(input({ reshare: true }))).rejects.toThrow('There is no finished backup to change.');
		slots.recovery_backup = { run: savedRun({ step: 'done', secretId: '0x' + 'ab'.repeat(32), version: 3, fee: { kind: 'self' } }) };
		await store.start(input({ reshare: true, fee: undefined }));
		expect(slots.recovery_backup.run).toMatchObject({ step: 'prepared', reshareOf: { secretId: '0x' + 'ab'.repeat(32), version: 3 }, fee: { kind: 'self' } });
	});
});

describe('two tabs', () => {
	it('a tab that cannot take the lock shows the run as driven elsewhere and leaves it alone', async () => {
		const store = useRecoveryBackupStore();
		localStorage.setItem('buckitup:device-label', 'computer-tab');
		slots.recovery_backup = { run: savedRun({ device: 'computer-tab' }) };
		await store.load();
		expect(store.runsHere).toBe(true);
		// The other tab holds the lock while it drives.
		let release;
		const other = lockManager.request('buckitup:backup-run:' + OWNER, () => new Promise((r) => (release = r)));
		await flush();
		expect(await store.resume()).toBe('busy');
		expect(store.heldElsewhere).toBe(true);
		expect(store.runsHere).toBe(false);
		expect(user.exportBackup).not.toHaveBeenCalled();
		release();
		await other;
	});

	it('drives from the run as saved, not from the copy this tab kept', async () => {
		const store = useRecoveryBackupStore();
		slots.recovery_backup = { run: savedRun() };
		await store.load();
		// Another tab published since: this tab's copy still says step 1.
		slots.recovery_backup = { run: savedRun({ step: 'published', vaultUuid: 'vault-uuid' }) };
		store.resume();
		await flush();
		expect(user.exportBackup).not.toHaveBeenCalled();
		expect(published).toHaveLength(0);
		expect(store.run.step).toBe('published');
	});
});

describe('switching accounts', () => {
	it('stops the run quietly, with nothing published or saved under the next account', async () => {
		const store = useRecoveryBackupStore();
		let exported;
		user.exportBackup = vi.fn(() => new Promise((r) => (exported = r)));
		await store.start(input());
		const saves = em.patchSlotJson.mock.calls.length;
		user.currentUserHash = U('f');
		exported({ identity: {} });
		await flush();
		await flush();
		expect(published).toHaveLength(0);
		expect(em.patchSlotJson.mock.calls.length).toBe(saves);
		expect(store.stopped).toBeNull();
		expect(store.running).toBe(false);
	});
});

describe('another device', () => {
	it('can continue a run that stopped moving there, and only then', async () => {
		const store = useRecoveryBackupStore();
		slots.recovery_backup = { run: savedRun({ device: 'phone-lost', updatedAt: Math.floor(Date.now() / 1000) - 60 }) };
		await store.load();
		expect(store.runsHere).toBe(false);
		expect(store.canTakeOver).toBe(false);
		await expect(store.takeOver()).rejects.toThrow('still moving on another device');

		slots.recovery_backup = { run: savedRun({ device: 'phone-lost', updatedAt: Math.floor(Date.now() / 1000) - 11 * 60 }) };
		await store.load();
		expect(store.canTakeOver).toBe(true);
		store.takeOver();
		await flush();
		expect(slots.recovery_backup.run.device).toBe(DEVICE());
		expect(store.runsHere).toBe(true);
		expect(user.exportBackup).toHaveBeenCalled();
	});

	it('the device a run was taken from writes nothing more', async () => {
		const store = useRecoveryBackupStore();
		let exported;
		user.exportBackup = vi.fn(() => new Promise((r) => (exported = r)));
		await store.start(input());
		const saves = em.patchSlotJson.mock.calls.length;
		slots.recovery_backup = { run: { ...slots.recovery_backup.run, device: 'phone-new' } };
		exported({ identity: {} });
		await flush();
		await flush();
		expect(em.patchSlotJson.mock.calls.length).toBe(saves);
		expect(published).toHaveLength(0);
		expect(slots.recovery_backup.run).toMatchObject({ step: 'prepared', device: 'phone-new' });
		expect(store.run.device).toBe('phone-new');
		expect(store.stopped).toBeNull();
	});
});
