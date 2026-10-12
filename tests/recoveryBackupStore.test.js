// @vitest-environment jsdom
// The backup store's start is the last gate before a registration that cannot
// be taken back: it refuses what the rules refuse, whatever screen called it,
// and once the run is saved it hands the run to the background.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const OWNER = 'u_' + 'a'.repeat(128);
const U = (c) => 'u_' + c.repeat(128);

const slots = {};
const em = {
	loadSlotJson: vi.fn(async (name) => slots[name] ?? null),
	patchSlotJson: vi.fn(async (name, patch) => (slots[name] = { ...(slots[name] ?? {}), ...patch })),
	exportVaultKeys: vi.fn(async () => ({ evm_skey: '11'.repeat(32) })),
};
// Step 2 waits on the account's export: a run started here stays at step 1.
const user = { currentUserHash: OWNER, contacts: [], contactsMap: {}, exportBackup: () => new Promise(() => {}) };
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

beforeEach(() => {
	setActivePinia(createPinia());
	for (const k of Object.keys(slots)) delete slots[k];
	em.patchSlotJson.mockClear();
});

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
