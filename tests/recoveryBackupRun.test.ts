// Creating a community backup as a resumable run (pq_recovery_shares
// § Issuing). Real splits, real stealth derivation; the network is faked
// honestly: a registered secret reads back, a refused deposit stays refused.
import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { computeAddress } from 'ethers';
import { computeStealthKey } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { joinHalves } from '@/lib/pq/vaultEnvelope';
import { fromBase64 } from '@/lib/pq/signature';
import { shamirCombine } from '@/lib/shamir';
import { checkShare, combineFriendsHalf, rootFromSlots } from '@/lib/recovery/shareSplit';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import {
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
import type { RecoverySharePart } from '@/lib/pq/content';

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
const fakeNetwork = (opts: { down?: string[]; confirmAfterReads?: number } = {}) => {
	const saved: BackupRun[] = [];
	const registered = new Map<string, { version: number; fields: any }>();
	const deposits: { node: string; share: string; version: number }[] = [];
	const sent: { guardian: string; part: RecoverySharePart }[] = [];
	const vaults: { key: string; json: string }[] = [];
	let reads = 0;
	let clock = 1000;
	const deps: RunDeps = {
		now: () => clock,
		save: async (r) => {
			saved.push(structuredClone(r));
		},
		exportAccount: async () => ACCOUNT,
		publishVault: async (key, json) => {
			vaults.push({ key: bytesToHex(key), json });
			return 'vault-uuid';
		},
		register: async (fields) => {
			const id = deps.secretIdOf(OWNER, fields.label);
			registered.set(id, { version: 1, fields });
			return { id, txHash: '0xtx' };
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
	return { deps, saved, registered, deposits, sent, vaults };
};

describe('a prepared run', () => {
	it('splits S so the guardians’ threshold and the nodes’ threshold give it back', () => {
		const run = newRun();
		expect(run.shares).toHaveLength(6); // 4 guardians + 2 spares
		const friends = combineFriendsHalf(run.shares.slice(1, 4).map((s, i) => ({ index: i + 2, share: fromBase64(s) })), 3);
		const node = shamirCombine(run.nodeShares.slice(2).map(hexToBytes));
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
		const first = await advance(newRun(), net.deps);
		const resumed = await advance({ ...first, step: 'submitted', sent: {}, nodeOutcomes: {} }, net.deps);
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
