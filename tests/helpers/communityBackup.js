// Fakes for the community backup screens: the backup store as its screens read
// it, and the runs and nodes it holds. The rules (backupPlan, nodeChoice,
// backupRun) stay real — only the store's network and storage are faked.
import { reactive } from 'vue';
import { vi } from 'vitest';

export const hash = (c) => 'u_' + c.repeat(128);

export const candidate = (name, status = 'agreed', c = name[0].toLowerCase()) => ({
	userHash: hash(c),
	name,
	status,
	metaAddress: status === 'agreed' ? `st:eth:0x${c.repeat(132)}` : null,
});

let nodeSeq = 0;
export const node = ({ operator, online = true, url } = {}) => {
	nodeSeq += 1;
	return {
		descriptor: {
			id: `node-${nodeSeq}`,
			url: url ?? `https://node${nodeSeq}.example.org/recovery/node`,
			chain: 'eip155:11155111',
			contract: '0x' + '1'.repeat(40),
			operator: operator ?? hash(String.fromCharCode(0x6b + (nodeSeq % 10))),
			issued_at: 1_700_000_000 + nodeSeq,
			node_pubkey: 'pk',
			node_sig: 'sig',
			operator_sig: 'osig',
		},
		online,
	};
};

export const settings = (over = {}) => ({ threshold: 2, approvals: 2, spares: 2, delaySec: 3 * 86400, windowSec: 7 * 86400, nodeThreshold: 2, ...over });

export const makeRun = (over = {}) => ({
	runId: 'run-1',
	label: 'bu-1',
	deployment: 'eip155:11155111:0x' + '1'.repeat(40),
	owner: '0x' + '2'.repeat(40),
	guardians: [hash('a'), hash('b'), hash('c')].map((userHash) => ({ userHash, metaAddress: 'st:eth:0x00' })),
	settings: settings(),
	nodes: [
		{ id: 'n1', url: 'https://n1.example.org/recovery/node' },
		{ id: 'n2', url: 'https://n2.example.org/recovery/node' },
		{ id: 'n3', url: 'https://n3.example.org/recovery/node' },
	],
	step: 'prepared',
	wrapKey: '00',
	splitId: 's',
	shares: [],
	leaves: [],
	root: '00',
	nodeShares: [],
	nodeOutcomes: {},
	skippedNodes: [],
	sent: {},
	startedAt: 1_700_000_000,
	updatedAt: 1_700_000_000,
	device: 'computer-abc123',
	alerts: { channels: ['app', 'telegram'], skipped: false },
	...over,
});

/** The backup store as the screens use it. */
export const fakeBackupStore = (over = {}) =>
	reactive({
		deployment: { chainId: 11155111 },
		run: null,
		reshare: null,
		// As the store: the run being made, else the record.
		get current() {
			return this.reshare ?? this.run;
		},
		loaded: true,
		running: false,
		stopped: null,
		candidates: [],
		// As the store: agreed, with the meta-address they agreed under.
		get pickable() {
			return this.candidates.filter((c) => c.status === 'agreed' && c.metaAddress);
		},
		hiddenContacts: 0,
		nodes: [],
		refusedNodes: {},
		runsHere: true,
		heldElsewhere: false,
		canTakeOver: false,
		takeOver: vi.fn(async () => {}),
		load: vi.fn(async () => {}),
		refreshRun: vi.fn(async () => {}),
		follow: vi.fn(),
		unfollow: vi.fn(),
		refreshNodes: vi.fn(async () => {}),
		addNodeUrl: vi.fn(),
		selfPayQuote: vi.fn(async () => ({ address: '0x7a3F' + '0'.repeat(32) + 'c91E', balance: '0.84', estimate: '0.02', enough: true })),
		// As the store: the channels as last listed, read through subscriptions().
		subs: [],
		subscriptions: vi.fn(async function () {
			return this.subs;
		}),
		staleSubscriptions: vi.fn(),
		holdings: { runId: null, byNode: {}, at: 0 },
		checkHoldings: vi.fn(async () => {}),
		addWebhook: vi.fn(),
		telegramLine: vi.fn(),
		walletForBot: vi.fn(async () => '0x' + 'ab'.repeat(20)),
		start: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		finishWithoutPendingNodes: vi.fn(async () => {}),
		discard: vi.fn(async () => {}),
		setAlerts: vi.fn(async () => {}),
		setPolicy: vi.fn(async () => {}),
		revoke: vi.fn(async () => {}),
		giveSpare: vi.fn(async () => {}),
		removeSubscription: vi.fn(async function (id) {
			this.subs = this.subs.filter((s) => s.id !== id);
			return this.subs;
		}),
		history: vi.fn(async () => []),
		receipts: {},
		receiptDetails: {},
		refreshReceipts: vi.fn(async () => {}),
		...over,
	});

export const fakeNav = () => ({ go: vi.fn(), back: vi.fn(), replace: vi.fn(), reset: vi.fn(), close: vi.fn(), refreshNodes: vi.fn() });
