// The account's holdings as the app runs them: the copy in the guardian slot
// beside the answers, consent read from that slot, one pass at a time so a
// state is told once however many renders hand the same share in, and
// nothing written once another account is signed in.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf, sharePartOf } from '@/lib/recovery/backupRun';
import { holdingKey } from '@/lib/recovery/holdings';
import { StorageNotOnServerError } from '@/lib/data/userStorage';

const NS = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const ID = '0x' + 'ab'.repeat(32);
const ME = 'u_' + 'g'.repeat(128);
const OWNER = 'u_' + 'o'.repeat(128);
const guardians = [1, 2, 3].map((n) => ({ userHash: 'u_' + String(n).repeat(128), metaAddress: metaKeysOf(new Uint8Array(32).fill(n)).metaAddress }));
const nodes = ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` }));
const run = { ...prepareRun({ deployment: NS, owner: '0x' + '77'.repeat(20), guardians, settings: defaultSettings(3, 3), nodes, device: 'd', now: 1 }), version: 1 };
const { kind: _kind, ...share } = sharePartOf(run, 0, `${NS}/${ID}`, 1);
const KEY = holdingKey(OWNER, share);

const H = vi.hoisted(() => ({ inputs: [], secret: null, chainReads: 0, offline: false }));
H.inputs = shareInputsOf(run);
vi.mock('@/lib/recovery/chain', async (importOriginal) => ({
	...(await importOriginal()),
	RecoveryChain: class {
		constructor() {
			H.chainReads = 0;
	H.offline = false;
		}
		async readSecret() {
			H.chainReads += 1;
			return H.secret;
		}
		async guardiansAt() {
			return H.inputs.map((s) => s.stealthAddress);
		}
		async shareAt(_id, _v, address) {
			return H.inputs.find((s) => s.stealthAddress === address);
		}
	},
}));

const slots = {};
const em = {
	loadSlotJson: vi.fn(async (name) => structuredClone(slots[name] ?? null)),
	// The slot's keyed merge, as the materializer applies it. Offline, the
	// write is durable on this device (read back from here on) and the
	// server has not taken it yet.
	patchSlotJson: vi.fn(async (name, patch) => {
		slots[name] = stripPatchDirectives(mergeJsonPatch(slots[name] ?? null, patch));
		if (H.offline) throw new StorageNotOnServerError('queued');
		return structuredClone(slots[name]);
	}),
	guardianMetaSeed: vi.fn(async () => '01'.repeat(32)),
};
const user = { currentUserHash: ME };
const sendMessage = vi.fn(async () => 'dmsg_x');
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ sendMessage }) }));

const { useRecoveryHoldingsStore } = await import('@/store/recoveryHoldings.store');

const accepted = { inv1: { owner: OWNER, deployment: NS, answer: 'accept', at: 5 } };
const reports = () => sendMessage.mock.calls.map(([to, parts]) => [to, parts[0].state]);

beforeEach(() => {
	setActivePinia(createPinia());
	for (const k of Object.keys(slots)) delete slots[k];
	slots.guardian = { answers: structuredClone(accepted) };
	em.loadSlotJson.mockClear();
	em.patchSlotJson.mockClear();
	sendMessage.mockClear();
	user.currentUserHash = ME;
	H.secret = { version: 1n, revoked: false };
	Object.defineProperty(globalThis, 'navigator', { value: { locks: makeFakeLockManager() }, configurable: true });
	const local = new Map();
	Object.defineProperty(globalThis, 'localStorage', {
		value: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, String(v)) },
		configurable: true,
	});
	H.chainReads = 0;
});

describe('a share the dialog hands in', () => {
	it('is copied into the guardian slot beside the answers, and its state told once', async () => {
		const store = useRecoveryHoldingsStore();
		await Promise.all([
			store.receive(OWNER, [{ messageId: 'dmsg_1', share }]),
			store.receive(OWNER, [{ messageId: 'dmsg_1', share }]),
		]);
		expect(slots.guardian.answers).toEqual(accepted);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ owner: OWNER, state: 'stored', reported: 'stored' });
		expect(slots.guardian.holdings[KEY].share.shareB64).toBe(share.shareB64);
		expect(reports()).toEqual([[OWNER, 'stored']]);
		expect(store.list.map((h) => h.key)).toEqual([KEY]);

		// Another render: nothing new, nothing read or written.
		const writes = em.patchSlotJson.mock.calls.length;
		const reads = em.loadSlotJson.mock.calls.length;
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(em.patchSlotJson.mock.calls.length).toBe(writes);
		expect(em.loadSlotJson.mock.calls.length).toBe(reads);
	});

	it('is unrequested when the slot holds no acceptance to that owner', async () => {
		slots.guardian = { answers: { inv1: { ...accepted.inv1, answer: 'decline' } } };
		await useRecoveryHoldingsStore().receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'unrequested' });
		expect(reports()).toEqual([[OWNER, 'unrequested']]);
	});

	it('writes nothing once another account is signed in', async () => {
		let release;
		em.loadSlotJson.mockImplementationOnce(async (name) => structuredClone(slots[name] ?? null));
		em.loadSlotJson.mockImplementationOnce(() => new Promise((r) => (release = () => r(structuredClone(slots.guardian)))));
		const store = useRecoveryHoldingsStore();
		const pass = store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		await vi.waitFor(() => expect(release).toBeDefined());
		user.currentUserHash = 'u_' + 'z'.repeat(128);
		release();
		await pass.catch(() => {});
		expect(em.patchSlotJson).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe('the periodic pass', () => {
	it('reads nothing on chain while nothing is kept', async () => {
		const store = useRecoveryHoldingsStore();
		await store.sweep();
		expect(H.chainReads).toBe(0);
		expect(em.patchSlotJson).not.toHaveBeenCalled();
	});

	it('stores a pending share once the chain shows it', async () => {
		H.secret = null;
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'pending' });
		H.secret = { version: 1n, revoked: false };
		await store.sweep();
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'stored' });
		expect(reports()).toEqual([[OWNER, 'stored']]);
	});

	it('asks the chain without the lock, and reads and writes the slot only when something changed', async () => {
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		const reads = em.loadSlotJson.mock.calls.length;
		const writes = em.patchSlotJson.mock.calls.length;
		expect(await store.sweep()).toEqual({ read: false });
		expect(H.chainReads).toBeGreaterThan(0);
		expect(em.loadSlotJson.mock.calls.length).toBe(reads);
		expect(em.patchSlotJson.mock.calls.length).toBe(writes);

		// Another tab swept a moment ago: this one skips its turn, unless asked.
		H.secret = { version: 1n, revoked: true };
		const chainReads = H.chainReads;
		await store.sweep();
		expect(H.chainReads).toBe(chainReads);
		expect(await store.sweep({ force: true })).toEqual({ read: true });
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'dropped' });
		expect(reports()).toEqual([[OWNER, 'stored'], [OWNER, 'dropped']]);
	});

	it('skips while the page is hidden', async () => {
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true });
		try {
			H.chainReads = 0;
			await store.sweep();
			expect(H.chainReads).toBe(0);
		} finally {
			delete globalThis.document;
		}
	});
});

describe('giving back', () => {
	it('removes the bytes from the slot and tells the owner', async () => {
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		await store.giveBack(KEY);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'given_back' });
		expect(slots.guardian.holdings[KEY].share.shareB64).toBe('');
		expect(reports()).toEqual([[OWNER, 'stored'], [OWNER, 'given_back']]);
		expect(store.holdings[KEY].state).toBe('given_back');
	});
});

describe('offline', () => {
	it('gives a piece back on this device and queues the report, saying it reaches the owner later', async () => {
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		H.offline = true;
		expect(await store.giveBack(KEY)).toEqual({ queued: true });
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'given_back', reported: 'given_back' });
		expect(slots.guardian.holdings[KEY].share.shareB64).toBe('');
		expect(reports()).toEqual([[OWNER, 'stored'], [OWNER, 'given_back']]);
		expect(store.holdings[KEY].state).toBe('given_back');
	});

	it('keeps a share received offline and tells the owner as the network allows', async () => {
		H.offline = true;
		await useRecoveryHoldingsStore().receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'stored', reported: 'stored' });
		expect(reports()).toEqual([[OWNER, 'stored']]);
	});

	it('still fails on a write that did not land anywhere', async () => {
		const store = useRecoveryHoldingsStore();
		await store.receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		em.patchSlotJson.mockRejectedValueOnce(new Error('refused'));
		await expect(store.giveBack(KEY)).rejects.toThrow('refused');
	});
});

describe('two tabs', () => {
	it('the tab that sweeps reads what another tab kept since, and judges its pending share', async () => {
		const tabB = createPinia();
		setActivePinia(tabB);
		const b = useRecoveryHoldingsStore();
		await b.load();
		expect(b.list).toEqual([]);

		setActivePinia(createPinia());
		H.secret = null;
		await useRecoveryHoldingsStore().receive(OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'pending' });

		H.secret = { version: 1n, revoked: false };
		setActivePinia(tabB);
		await b.sweep();
		expect(slots.guardian.holdings[KEY]).toMatchObject({ state: 'stored', reported: 'stored' });
		expect(b.list.map((h) => h.state)).toEqual(['stored']);
	});
});
