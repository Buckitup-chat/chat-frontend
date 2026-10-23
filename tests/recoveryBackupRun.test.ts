// Creating a community backup as a resumable run (pq_recovery_shares
// § Issuing). Real splits, real stealth derivation; the network is faked
// honestly: a registered secret reads back, a refused deposit stays refused.
import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { computeAddress } from 'ethers';
import { computeStealthKey } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { joinHalves } from '@buckitup/pq-client/vaultEnvelope';
import { fromBase64 } from '@buckitup/pq-client/signature';
import { shamirCombine } from '@/lib/shamir';
import { checkShare, combineFriendsHalf, rootFromSlots } from '@/lib/recovery/shareSplit';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import {
	REGISTRATION_WAIT_MS,
	RunAbortedError,
	RunStoppedError,
	advance,
	canDiscard,
	canFinishWithoutPending,
	prepareRun,
	skipPendingNodes,
	stepNumber,
	type BackupRun,
	type RunDeps,
} from '@/lib/recovery/backupRun';
import type { RecoverySharePart } from '@buckitup/pq-client/content';

const keysOf = (n: number) => metaKeysOf(new Uint8Array(32).fill(n));
const GUARDIANS = [1, 2, 3, 4].map((n) => ({ userHash: 'u_' + String(n).repeat(128), metaAddress: keysOf(n).metaAddress, keys: keysOf(n) }));
const NODES = ['a', 'b', 'c', 'd', 'e'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` }));
const OWNER = '0x' + '77'.repeat(20);
const ACCOUNT = { identity: { user_hash: 'u_' + 'o'.repeat(128) }, keys: { sign_skey: 'k' } };

const newRun = (): BackupRun =>
	prepareRun({
		deployment: 'eip155:11155111:0xd9ff',
		owner: OWNER,
		guardians: GUARDIANS.map(({ userHash, metaAddress }) => ({ userHash, metaAddress })),
		settings: defaultSettings(4, 5),
		nodes: NODES,
		device: 'laptop',
		now: 1000,
	});

/** A fake network: what is registered reads back; nodes in `down` refuse. */
const fakeNetwork = (opts: { down?: string[]; confirmAfterReads?: number; saveDelay?: (r: BackupRun) => number } = {}) => {
	const saved: BackupRun[] = [];
	const registered = new Map<string, { version: number; fields: any }>();
	const deposits: { node: string; share: string; version: number }[] = [];
	const sent: { guardian: string; part: RecoverySharePart }[] = [];
	const vaults: { key: string; json: string }[] = [];
	/** Each retirement, with the step the run had reached and the shares out by then. */
	const retired: { keep: string; step: string; sent: number; deposits: number }[] = [];
	let reads = 0;
	let clock = 1000;
	const deps: RunDeps = {
		now: () => clock,
		save: async (r) => {
			const delay = opts.saveDelay?.(r) ?? 0;
			if (delay) await new Promise((ok) => setTimeout(ok, delay));
			saved.push(structuredClone(r));
		},
		exportAccount: async () => ACCOUNT,
		publishVault: async (key, json) => {
			vaults.push({ key: bytesToHex(key), json });
			return 'vault-uuid';
		},
		retireVaults: async (keep) => {
			const last = saved.at(-1)!;
			retired.push({ keep, step: last.step, sent: sent.length, deposits: deposits.length });
		},
		register: async (fields) => {
			const id = deps.secretIdOf(OWNER, fields.label);
			registered.set(id, { version: 1, fields });
			return { id, txHash: '0xtx' };
		},
		reshare: async (fields) => {
			const prev = registered.get(fields.id);
			if (!prev) throw new Error('SecretDoesNotExist');
			registered.set(fields.id, { version: prev.version + 1, fields });
			return { txHash: '0xreshare' };
		},
		secretIdOf: (owner, label) => `0x${bytesToHex(new TextEncoder().encode(owner + label)).slice(0, 64)}`,
		readVersion: async (id) => {
			reads++;
			if (opts.confirmAfterReads && reads < opts.confirmAfterReads) return null;
			return registered.get(id)?.version ?? null;
		},
		sleep: async (ms) => {
			clock += ms / 1000;
		},
		deposit: async (node, d) => {
			if (opts.down?.includes(node.id)) throw new Error('does not answer');
			deposits.push({ node: node.id, share: d.share, version: d.version });
			return { staged: false };
		},
		sendShare: async (guardian, part) => {
			sent.push({ guardian, part });
			return 'dmsg_' + sent.length;
		},
		secretRefOf: (id) => `eip155:11155111:0xd9ff/${id}`,
	};
	return { deps, saved, registered, deposits, sent, vaults, retired, tick: (sec: number) => (clock += sec) };
};

describe('a prepared run', () => {
	it('splits S so the guardians’ threshold and the nodes’ threshold give it back', () => {
		const run = newRun();
		expect(run.shares).toHaveLength(6); // 4 guardians + 2 spares
		const friends = combineFriendsHalf(run.shares.slice(1, 4).map((s, i) => ({ index: i + 2, share: fromBase64(s!) })), 3);
		const node = shamirCombine(run.nodeShares.slice(2).map((s) => hexToBytes(s!)));
		expect(bytesToHex(joinHalves(node, friends))).toBe(run.wrapKey);
		expect(canDiscard(run)).toBe(true);
		expect(stepNumber(run)).toBe(1);
	});
});

describe('advancing a run', () => {
	it('publishes, registers, deposits and sends, saving every step', async () => {
		const net = fakeNetwork();
		const done = await advance(newRun(), net.deps);
		expect(done.step).toBe('done');
		expect(net.saved.map((r) => r.step)).toEqual(expect.arrayContaining(['published', 'submitted', 'registered', 'done']));

		// The vault opens with S and carries the spares, not the guardians' shares.
		const vault = JSON.parse(net.vaults[0].json);
		expect(net.vaults[0].key).toBe(done.wrapKey);
		expect(vault.identity).toEqual(ACCOUNT.identity);
		expect(vault.community_backup.spares.map((s: any) => s.index)).toEqual([5, 6]);

		// One slot carries the root; each is a stealth address only its guardian can open.
		const fields = [...net.registered.values()][0].fields;
		expect(fields.threshold).toBe(3n);
		expect(bytesToHex(rootFromSlots(fields.shares.map((s: any) => hexToBytes(s.shareEncrypted.slice(2))))!)).toBe(done.root);
		fields.shares.forEach((slot: any, i: number) => {
			const key = computeStealthKey(
				{ spendingPrivateKey: GUARDIANS[i].keys.spendingPrivateKey, viewingPrivateKey: GUARDIANS[i].keys.viewingPrivateKey },
				slot.ephemeralPubKey,
			);
			expect(computeAddress(key).toLowerCase()).toBe(slot.stealthAddress.toLowerCase());
		});

		// Each node has its share at the registered version; each guardian a share that checks against the root.
		expect(net.deposits.map((d) => d.node).sort()).toEqual(NODES.map((n) => n.id).sort());
		expect(net.sent.map((s) => s.guardian)).toEqual(GUARDIANS.map((g) => g.userHash));
		for (const { part } of net.sent) {
			expect(() =>
				checkShare(
					{ ...part, index: part.shareIndex, share: fromBase64(part.shareB64), proof: part.splitProof.map(fromBase64) },
					hexToBytes(done.root),
				),
			).not.toThrow();
		}
		expect(stepNumber(done)).toBe(6);
	});

	it('does not register twice when resumed after a submission', async () => {
		const net = fakeNetwork();
		await advance(newRun(), net.deps);
		const atSubmission = net.saved.filter((r) => r.step === 'submitted').at(-1)!;
		const resumed = await advance(atSubmission, net.deps);
		expect(net.registered.size).toBe(1);
		expect(resumed.step).toBe('done');
	});

	it('waits for the network, and stops with the run saved if it does not confirm in time', async () => {
		const slow = fakeNetwork({ confirmAfterReads: 4 });
		expect((await advance(newRun(), slow.deps)).step).toBe('done');
		const never = fakeNetwork({ confirmAfterReads: 10_000 });
		const stopped = await advance(newRun(), never.deps).catch((e) => e);
		expect(stopped).toBeInstanceOf(RunStoppedError);
		expect(stopped.reason).toBe('registration_pending');
		expect(never.saved.at(-1)!.step).toBe('submitted');
	});

	it('sends the guardians their shares while a node is down, then finishes without it if the rest are enough', async () => {
		const net = fakeNetwork({ down: [NODES[4].id] });
		const stopped = await advance(newRun(), net.deps).catch((e) => e);
		expect(stopped).toBeInstanceOf(RunStoppedError);
		expect(stopped.reason).toBe('nodes_failed');
		const run: BackupRun = net.saved.at(-1)!;
		expect(Object.keys(run.sent)).toHaveLength(4);
		expect(run.nodeOutcomes[NODES[4].id]).toMatchObject({ state: 'failed' });
		expect(canDiscard(run)).toBe(false);
		expect(stepNumber(run)).toBe(4);
		expect(canFinishWithoutPending(run)).toBe(true);
		const finished = await advance(skipPendingNodes(run), net.deps);
		expect(finished.step).toBe('done');
		expect(net.sent).toHaveLength(4); // nobody got a second share
	});

	it('cannot finish without nodes when too few others have their part', async () => {
		const net = fakeNetwork({ down: NODES.slice(2).map((n) => n.id) });
		await advance(newRun(), net.deps).catch(() => undefined);
		const run = net.saved.at(-1)!;
		expect(canFinishWithoutPending(run)).toBe(false);
		expect(() => skipPendingNodes(run)).toThrow();
	});
});

describe('secret material in the record', () => {
	it('drops each node\'s share once it holds it, and every handed-out share at done', async () => {
		const net = fakeNetwork({ down: [NODES[4].id] });
		await advance(newRun(), net.deps).catch(() => undefined);
		const stopped = net.saved.at(-1)!;
		// Only the share still owed stays.
		expect(stopped.nodeShares.map((s, i) => (s ? NODES[i].id : null)).filter(Boolean)).toEqual([NODES[4].id]);
		expect(stopped.shares.every(Boolean)).toBe(true);

		const done = await advance(skipPendingNodes(stopped), net.deps);
		expect(done.step).toBe('done');
		const record = net.saved.at(-1)!;
		expect(record.nodeShares.every((s) => s === null)).toBe(true);
		expect(record.shares.slice(0, 4)).toEqual([null, null, null, null]);
		// S and the spares stay in the owner's account.
		expect(record.shares.slice(4).every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
		expect(record.wrapKey).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('registering', () => {
	it('records the submission before it leaves', async () => {
		const net = fakeNetwork();
		const register = net.deps.register;
		let stepAtSubmission: string | undefined;
		net.deps.register = async (fields) => {
			stepAtSubmission = net.saved.at(-1)!.step;
			expect(net.saved.at(-1)!.submittedAt).toBe(1000);
			return register(fields);
		};
		await advance(newRun(), net.deps);
		expect(stepAtSubmission).toBe('submitted');
		expect(net.saved.find((r) => r.txHash)?.step).toBe('submitted');
	});

	it('waits for a fresh submission, and hands a dropped one over again with the same slots', async () => {
		const net = fakeNetwork();
		let calls = 0;
		const register = net.deps.register;
		net.deps.register = async (fields) => {
			calls++;
			// The first one is dropped on the way.
			if (calls === 1) return { id: net.deps.secretIdOf(OWNER, fields.label), txHash: '0xlost' };
			return register(fields);
		};
		const stopped = await advance(newRun(), net.deps).catch((e) => e);
		expect(stopped.reason).toBe('registration_pending');
		const atSubmission = net.saved.at(-1)!;

		// Resumed while it may still land: no second submission.
		const early = { ...atSubmission, submittedAt: net.deps.now() - 60 };
		await advance(early, net.deps).catch(() => undefined);
		expect(calls).toBe(1);

		// Past the wait: the same slots go out again, and the run finishes.
		const done = await advance(atSubmission, net.deps);
		expect(calls).toBe(2);
		expect(done.step).toBe('done');
		expect([...net.registered.values()][0].fields.shares).toEqual(atSubmission.shareInputs);
	});

	it('goes on when a resubmission is refused because the secret already exists', async () => {
		const net = fakeNetwork();
		await advance(newRun(), net.deps);
		const atSubmission = net.saved.filter((r) => r.step === 'submitted').at(-1)!;
		// The chain answers late once: the secret looks absent, and the resubmission reverts.
		const readVersion = net.deps.readVersion;
		let lag = 1;
		net.deps.readVersion = async (id) => (lag-- > 0 ? null : readVersion(id));
		let calls = 0;
		net.deps.register = async () => {
			calls++;
			throw new Error('execution reverted: secret exists');
		};
		net.tick(REGISTRATION_WAIT_MS / 1000 + 1);
		const resumed = await advance(atSubmission, net.deps);
		expect(calls).toBe(1);
		expect(resumed.step).toBe('done');
	});

	it('lets the next attempt submit at once when the service refused', async () => {
		const net = fakeNetwork();
		net.deps.register = async () => {
			throw new Error('the service refused');
		};
		await expect(advance(newRun(), net.deps)).rejects.toThrow('the service refused');
		expect(net.saved.at(-1)).toMatchObject({ step: 'submitted', submittedAt: 0 });
	});
});

describe('node outcomes', () => {
	it('records every deposit as it ends, none lost when they land together', async () => {
		// Slow saves: the outcomes queue up behind the guardians' sends.
		const net = fakeNetwork({ down: [NODES[0].id], saveDelay: (r) => (r.step === 'registered' ? 2 : 0) });
		await advance(newRun(), net.deps).catch(() => undefined);
		const record = net.saved.at(-1)!;
		expect(Object.keys(record.nodeOutcomes).sort()).toEqual(NODES.map((n) => n.id).sort());
		expect(Object.keys(record.sent)).toHaveLength(4);
		// Each outcome got its own save.
		const outcomeSaves = net.saved.filter((r, i) => i > 0 && Object.keys(r.nodeOutcomes).length > Object.keys(net.saved[i - 1].nodeOutcomes).length);
		expect(outcomeSaves).toHaveLength(5);
	});

	it('saves the deposits\' outcomes before stopping on a guardian send that failed', async () => {
		const net = fakeNetwork();
		net.deps.sendShare = async () => {
			throw new Error('the dialog is not ready');
		};
		const err = await advance(newRun(), net.deps).catch((e) => e);
		expect(err.message).toBe('the dialog is not ready');
		const record = net.saved.at(-1)!;
		expect(Object.values(record.nodeOutcomes).map((o) => o.state)).toEqual(['held', 'held', 'held', 'held', 'held']);
	});

	it('stops at once on an interruption, rather than recording it as a node that failed', async () => {
		const net = fakeNetwork();
		net.deps.deposit = async () => {
			throw new RunAbortedError();
		};
		const err = await advance(newRun(), net.deps).catch((e) => e);
		expect(err).toBeInstanceOf(RunAbortedError);
		expect(Object.values(net.saved.at(-1)!.nodeOutcomes).some((o) => o.state === 'failed')).toBe(false);
	});
});

describe('a reshare', () => {
	it('moves the same secret to its next version under a new S, and sends the new shares', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const reshared = prepareRun({
			deployment: 'eip155:11155111:0xd9ff',
			owner: OWNER,
			guardians: GUARDIANS.slice(0, 3).map(({ userHash, metaAddress }) => ({ userHash, metaAddress })),
			settings: defaultSettings(3, 5),
			nodes: NODES,
			device: 'laptop',
			now: 2000,
			reshareOf: { secretId: first.secretId!, version: first.version! },
		});
		expect(reshared.wrapKey).not.toBe(first.wrapKey);
		const done = await advance(reshared, net.deps);
		expect(done).toMatchObject({ step: 'done', secretId: first.secretId, version: 2 });
		expect(net.registered.size).toBe(1);
		expect(net.sent.slice(4).map((s) => s.part.version)).toEqual([2, 2, 2]);
		expect(net.deposits.filter((d) => d.version === 2)).toHaveLength(NODES.length);
	});

	it('retires the vault it replaces only once it is on chain and every piece is out, keeping its own', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const sent = net.sent.length;
		const deposits = net.deposits.length;
		const done = await advance({ ...resharing(first), vaultUuid: undefined }, { ...net.deps, publishVault: async () => 'vault-2' });
		expect(done.step).toBe('done');
		expect(net.retired.at(-1)).toEqual({ keep: 'vault-2', step: 'registered', sent: sent + 3, deposits: deposits + NODES.length });
	});

	it('retires nothing for a reshare that has not landed, or whose pieces are not all out', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const retiredBefore = net.retired.length;
		const pending = await advance(resharing(first), { ...net.deps, reshare: async () => ({}) }).catch((e) => e);
		expect(pending.reason).toBe('registration_pending');
		const down = await advance(resharing(first), { ...fakeNetwork({ down: [NODES[0].id] }).deps, readVersion: net.deps.readVersion, reshare: net.deps.reshare, retireVaults: net.deps.retireVaults }).catch((e) => e);
		expect(down.reason).toBe('nodes_failed');
		expect(net.retired).toHaveLength(retiredBefore);
	});

	it('stops short of done when the old vault could not be retired, and retires it when continued', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		let refuse = true;
		const deps = { ...net.deps, retireVaults: async (keep: string) => (refuse ? Promise.reject(new Error('rejected')) : net.deps.retireVaults(keep)) };
		await expect(advance(resharing(first), deps)).rejects.toThrow('rejected');
		const stopped = net.saved.at(-1)!;
		expect(stopped.step).toBe('registered');
		refuse = false;
		expect((await advance(stopped, deps)).step).toBe('done');
	});

	it('waits for the next version, not the one it replaces', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const run = { ...prepareRun({ deployment: 'x', owner: OWNER, guardians: GUARDIANS.slice(0, 3).map(({ userHash, metaAddress }) => ({ userHash, metaAddress })), settings: defaultSettings(3, 5), nodes: NODES, device: 'd', now: 1, reshareOf: { secretId: first.secretId!, version: first.version! } }), step: 'submitted' as const, submittedAt: 1000 };
		// Submitted, not yet mined: the chain still shows version 1, which is not this reshare.
		const stopped = await advance(run, { ...net.deps, reshare: async () => ({}) }).catch((e) => e);
		expect(stopped).toBeInstanceOf(RunStoppedError);
		expect(stopped.reason).toBe('registration_pending');
	});

	const resharing = (first: BackupRun, over: Partial<BackupRun> = {}): BackupRun => ({
		...prepareRun({ deployment: 'x', owner: OWNER, guardians: GUARDIANS.slice(0, 3).map(({ userHash, metaAddress }) => ({ userHash, metaAddress })), settings: defaultSettings(3, 5), nodes: NODES, device: 'd', now: 1, reshareOf: { secretId: first.secretId!, version: first.version! } }),
		...over,
	});

	it('stops, sending nothing, when another change took the secret further than the next version', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const sentBefore = net.sent.length;
		// This reshare went out; meanwhile two other changes landed.
		net.registered.set(first.secretId!, { version: 3, fields: {} });
		const stopped = await advance(resharing(first, { step: 'submitted', submittedAt: 1000 }), net.deps).catch((e) => e);
		expect(stopped).toBeInstanceOf(RunStoppedError);
		expect(stopped.reason).toBe('version_moved');
		expect(net.sent.length).toBe(sentBefore);
		expect(net.deposits.filter((d) => d.version === 3)).toHaveLength(0);
		expect(net.saved.at(-1)).toMatchObject({ superseded: 3, step: 'submitted' });
		expect(canDiscard(net.saved.at(-1)!)).toBe(true);
	});

	it('does not take a next version it never sent for its own', async () => {
		const net = fakeNetwork();
		const first = await advance(newRun(), net.deps);
		const published = { ...resharing(first), step: 'published' as const, vaultUuid: 'v' };
		// Another device's reshare landed at the next version before this one was sent.
		net.registered.set(first.secretId!, { version: 2, fields: {} });
		let reshared = false;
		const stopped = await advance(published, { ...net.deps, reshare: async () => ((reshared = true), {}) }).catch((e) => e);
		expect(stopped).toMatchObject({ reason: 'version_moved' });
		expect(reshared).toBe(false);
	});
});
