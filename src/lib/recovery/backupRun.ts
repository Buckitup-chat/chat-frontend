// Creating a community backup, as a run that survives a closed tab (chat repo:
// pq_recovery_shares § Issuing; docs/backup-recovery-plan.md § 7.2). Each step
// is recorded before the next begins, in the owner's own user_storage, so a
// resume on this device or another starts where the last one stopped and
// never makes a second split: a client that registers and then loses its split
// can only reshare.
//
// The steps, as the progress screen counts them:
//   1 prepare  — the wrap key S, its halves, the friends' split with spares,
//                the node half's split; recorded before anything leaves.
//   2 publish  — the vault, sealed under S, with the spares inside.
//   3 register — addSecret with a delivery record in each guardian slot. From
//                here the backup exists, and nothing is undone.
//   4 nodes    — each node gets its share of the node half,
//   5 guardians — and each guardian theirs, in their dialog; neither waits
//                for the other, so a node that is down holds nobody's share.
//   6 done     — the run is the backup's record.
//
// Secret material and the slot. Until it is delivered, every piece the run
// hands out lives in the run's record: a resume — after a closed tab, or on
// another device — must send exactly the pieces of the one split, and nothing
// else has them. They leave the record as they are delivered: a node's share
// once that node holds it, and at 'done' every node share and every
// guardian's share. What stays is S and the spares, which the scheme keeps in
// the owner's account (§ Issuing), and what is not secret.
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { generateStealthAddress } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { newWrapKey, splitIntoHalves } from '@/lib/pq/vaultEnvelope';
import { toBase64Unpadded } from '@/lib/pq/signature';
import type { RecoverySharePart } from '@/lib/pq/content';
import { shamirSplit } from '@/lib/shamir';
import type { BackupContents } from '@/lib/backupContents';
import { deliveryRecord, deliveryTag, splitFriendsHalf } from './shareSplit';
import type { BackupSettings } from './backupPlan';
import type { NodeRef } from './nodeClient';
import type { ShareInput } from './gateway';

export type RunStep = 'prepared' | 'published' | 'submitted' | 'registered' | 'done' | 'discarded';

/** The step the progress screen marks as current (1–6). */
export const stepNumber = (run: BackupRun): number => {
	if (run.step === 'prepared') return 1;
	if (run.step === 'published') return 2;
	if (run.step === 'submitted') return 3;
	if (run.step === 'done') return 6;
	return nodesPending(run).length ? 4 : 5;
};

/** Steps 1–2 can be discarded: nothing is on chain yet. */
export const canDiscard = (run: BackupRun): boolean => run.step === 'prepared' || run.step === 'published';

export interface RunGuardian {
	userHash: string;
	/** From their acceptance (§ Inviting); the slot is derived from it. */
	metaAddress: string;
}

export type NodeOutcome = { state: 'held' } | { state: 'staged' } | { state: 'failed'; error: string; at: number };

/** The run, and once done the backup's record. Secret material is kept here, encrypted under the owner's account. */
export interface BackupRun {
	runId: string;
	/** The on-chain label: random, so the secret id links to nothing. */
	label: string;
	/** `eip155:<chainId>:<contract>`. */
	deployment: string;
	/** The owner's EVM address: the secret's owner on chain. */
	owner: string;
	guardians: RunGuardian[];
	settings: BackupSettings;
	nodes: NodeRef[];
	step: RunStep;
	/** S, hex: it opens the vault. */
	wrapKey: string;
	splitId: string;
	/**
	 * Shamir shares of the friends' half, unpadded base64; the first
	 * `guardians.length` go to guardians, the rest are spares. A guardian's
	 * entry is null once the run is done.
	 */
	shares: (string | null)[];
	/** Every share's leaf, unpadded base64: each share's split_proof. */
	leaves: string[];
	/** The split's root, hex. */
	root: string;
	/** Shares of the node half, hex, one per node in `nodes` order; null once that node took it, and all null once done. */
	nodeShares: (string | null)[];
	vaultUuid?: string;
	/** Fixed before the first submission, so every resubmission names the same slots. */
	shareInputs?: ShareInput[];
	secretId?: string;
	version?: number;
	txHash?: string;
	/** When the registration was last handed to the network, unix seconds; 0 when that attempt failed. */
	submittedAt?: number;
	nodeOutcomes: Record<string, NodeOutcome>;
	/** Nodes the owner chose to finish without. */
	skippedNodes: string[];
	/** Guardian → the message their share went in. */
	sent: Record<string, { messageId: string; shareIndex: number }>;
	startedAt: number;
	updatedAt: number;
	/** The device that runs it; another shows its progress rather than starting a second. */
	device: string;
	/** How the registration is paid: the free service (optionally another one), or the owner's own address. */
	fee?: { kind: 'relayer'; url?: string } | { kind: 'self' };
	/** The alert channels set up with it, or that the owner skipped them. */
	alerts?: { channels: ('app' | 'telegram' | 'webhook')[]; skipped: boolean };
}

export interface RunInput {
	deployment: string;
	owner: string;
	guardians: RunGuardian[];
	settings: BackupSettings;
	nodes: NodeRef[];
	device: string;
	now: number;
}

/** The node set as a share names it: the threshold and each node as `<id>@<url>`. */
export const nodeSetOf = (threshold: number, nodes: readonly NodeRef[]): { threshold: number; nodes: string[] } => ({
	threshold,
	nodes: nodes.map((n) => `${n.id}@${n.url}`),
});

/** Step 1: S, its halves, both splits — everything later steps send, decided once. */
export const prepareRun = (input: RunInput): BackupRun => {
	const { guardians, settings, nodes } = input;
	const wrapKey = newWrapKey();
	const { nodeHalf, friendsHalf } = splitIntoHalves(wrapKey);
	const split = splitFriendsHalf(friendsHalf, guardians.length + settings.spares, settings.threshold, nodeSetOf(settings.nodeThreshold, nodes));
	return {
		runId: bytesToHex(randomBytes(16)),
		label: 'bu-' + bytesToHex(randomBytes(16)),
		deployment: input.deployment,
		owner: input.owner,
		guardians: guardians.map((g) => ({ ...g })),
		settings: { ...settings },
		nodes: nodes.map((n) => ({ ...n })),
		step: 'prepared',
		wrapKey: bytesToHex(wrapKey),
		splitId: split.splitId,
		shares: split.shares.map(toBase64Unpadded),
		leaves: split.leaves.map(toBase64Unpadded),
		root: bytesToHex(split.root),
		nodeShares: shamirSplit(nodeHalf, nodes.length, settings.nodeThreshold).map(bytesToHex),
		nodeOutcomes: {},
		skippedNodes: [],
		sent: {},
		startedAt: input.now,
		updatedAt: input.now,
		device: input.device,
	};
};

/** The vault's contents: the account, and the spares — sealed under S, they cost nothing an attacker with the vault lacks. */
export const vaultJsonOf = (run: BackupRun, account: BackupContents): string =>
	JSON.stringify({
		...account,
		community_backup: {
			split_id: run.splitId,
			spares: run.shares.slice(run.guardians.length).map((share, i) => ({ index: run.guardians.length + i + 1, share: share! })),
		},
	});

/** Each guardian's slot: a fresh stealth address from their meta-address; the first carries the split's root. */
export const shareInputsOf = (run: BackupRun): ShareInput[] =>
	run.guardians.map((g, i) => {
		const { address: stealthAddress, ephemeralPubKey } = generateStealthAddress(g.metaAddress);
		const record = i === 0 ? deliveryRecord(hexToBytes(run.root)) : deliveryTag();
		return { stealthAddress, ephemeralPubKey, shareEncrypted: `0x${bytesToHex(record)}` } as ShareInput;
	});

/** Guardian `i`'s share, as their dialog carries it. */
export const sharePartOf = (run: BackupRun, i: number, secretRef: string, now: number): RecoverySharePart => ({
	kind: 'recovery_share',
	secretRef,
	version: run.version!,
	threshold: run.settings.threshold,
	total: run.shares.length,
	shareB64: run.shares[i]!,
	createdAt: now,
	splitId: run.splitId,
	shareIndex: i + 1,
	splitProof: [...run.leaves],
	nodeSet: nodeSetOf(run.settings.nodeThreshold, run.nodes),
});

/** Nodes still owed their share: neither holding it, nor staged, nor skipped. */
export const nodesPending = (run: BackupRun): NodeRef[] =>
	run.nodes.filter((n) => !run.skippedNodes.includes(n.id) && !['held', 'staged'].includes(run.nodeOutcomes[n.id]?.state ?? ''));

/** Nodes that took their share. */
export const nodesDone = (run: BackupRun): number => run.nodes.filter((n) => ['held', 'staged'].includes(run.nodeOutcomes[n.id]?.state ?? '')).length;

/** Whether the run may finish without the nodes still pending: the rest already reach the node threshold. */
export const canFinishWithoutPending = (run: BackupRun): boolean => nodesDone(run) >= run.settings.nodeThreshold;

export interface RunDeps {
	now: () => number;
	/** Persists the run; the next step waits for it. */
	save: (run: BackupRun) => Promise<void>;
	exportAccount: () => Promise<BackupContents>;
	/** Seals `json` under `wrapKey` and stores it where the key alone finds it; resolves to its uuid. */
	publishVault: (wrapKey: Uint8Array, json: string) => Promise<string>;
	/** Signs addSecret as the owner and submits it; resolves to the secret id and the dispatch. */
	register: (fields: { label: string; shares: ShareInput[]; threshold: bigint; recoveryDelay: bigint; recoveryWindow: bigint }) => Promise<{ id: string; txHash?: string }>;
	/** The secret's id for this owner and label, without the chain. */
	secretIdOf: (owner: string, label: string) => string;
	/** The secret's version once on chain, else null; throws when the chain does not answer. */
	readVersion: (id: string) => Promise<number | null>;
	/** Waits before the chain is read again. */
	sleep: (ms: number) => Promise<void>;
	deposit: (node: NodeRef, deposit: { id: string; version: number; share: string }) => Promise<{ staged: boolean }>;
	/** Sends `part` to the guardian; resolves to the message id once captured durably. */
	sendShare: (guardian: string, part: RecoverySharePart) => Promise<string>;
	secretRefOf: (id: string) => string;
}

/** How long a registration is waited for before the run stops and says so, and before it is handed over again. */
export const REGISTRATION_WAIT_MS = 10 * 60_000;
const POLL_MS = 5_000;

export class RunStoppedError extends Error {
	constructor(readonly run: BackupRun, readonly reason: 'registration_pending' | 'nodes_failed', message: string) {
		super(message);
	}
}

/** The run cannot go on here, and nothing more may be written for it: stop without a word to the slot. */
export class RunInterruptedError extends Error {}
/** The account this run belongs to is no longer the one signed in. */
export class RunAbortedError extends RunInterruptedError {
	constructor() {
		super('The account changed while the backup was being created.');
	}
}
/** Another device continued the run. */
export class RunTakenOverError extends RunInterruptedError {
	constructor() {
		super('Another device continued this backup.');
	}
}

/** The record once every piece is out: S and the spares stay, the guardians' and nodes' shares go. */
const scrubbed = (run: BackupRun): Partial<BackupRun> => ({
	shares: run.shares.map((share, i) => (i < run.guardians.length ? null : share)),
	nodeShares: run.nodeShares.map(() => null),
});

type Change = Partial<BackupRun> | ((run: BackupRun) => Partial<BackupRun>);

/**
 * Runs `run` forward from its step until it is done or a step cannot finish:
 * a registration not on chain in time, or nodes that refused. Each step is
 * saved before the next begins; a throw leaves the run where it stood. Saves
 * go one at a time, each applied to the record as the previous one left it,
 * so outcomes recorded side by side never drop each other.
 */
export const advance = async (run: BackupRun, deps: RunDeps, onStep?: (run: BackupRun) => void): Promise<BackupRun> => {
	let queue: Promise<void> = Promise.resolve();
	const step = (change: Change): Promise<void> => {
		const next = queue.then(async () => {
			const changes = typeof change === 'function' ? change(run) : change;
			const updated = { ...run, ...changes, updatedAt: deps.now() };
			await deps.save(updated);
			run = updated;
			onStep?.(run);
		});
		queue = next.catch(() => undefined);
		return next;
	};

	if (run.step === 'prepared') {
		const vaultUuid = await deps.publishVault(hexToBytes(run.wrapKey), vaultJsonOf(run, await deps.exportAccount()));
		await step({ step: 'published', vaultUuid });
	}

	if (run.step === 'published' || run.step === 'submitted') {
		const id = deps.secretIdOf(run.owner, run.label);
		let version = await deps.readVersion(id);
		// The step and its time are saved before the registration leaves: a run
		// that stops after the broadcast waits for it rather than sending again
		// blindly. One not on chain after REGISTRATION_WAIT_MS is handed over
		// again with the same slots — a duplicate is dropped by the service or
		// reverts because the secret exists, and the chain then shows it.
		const stale = run.step === 'submitted' && deps.now() - (run.submittedAt ?? 0) > REGISTRATION_WAIT_MS / 1000;
		if (version === null && (run.step === 'published' || stale)) {
			if (!run.shareInputs) await step({ shareInputs: shareInputsOf(run) });
			await step({ step: 'submitted', secretId: id, submittedAt: deps.now() });
			try {
				const { txHash } = await deps.register({
					label: run.label,
					shares: run.shareInputs!,
					threshold: BigInt(run.settings.approvals),
					recoveryDelay: BigInt(run.settings.delaySec),
					recoveryWindow: BigInt(run.settings.windowSec),
				});
				await step({ txHash });
			} catch (e) {
				if (e instanceof RunInterruptedError) throw e;
				version = await deps.readVersion(id);
				if (version === null) {
					// Not handed over: the next attempt may submit at once.
					await step({ submittedAt: 0 });
					throw e;
				}
			}
		}
		const deadline = deps.now() * 1000 + REGISTRATION_WAIT_MS;
		while (version === null) {
			version = await deps.readVersion(id);
			if (version !== null) break;
			if (deps.now() * 1000 >= deadline) {
				throw new RunStoppedError(run, 'registration_pending', 'The network has not confirmed the registration yet.');
			}
			await deps.sleep(POLL_MS);
		}
		await step({ step: 'registered', secretId: id, version });
	}

	if (run.step === 'registered') {
		const ref = deps.secretRefOf(run.secretId!);
		// Each deposit is recorded as it ends; a node that took its share has it dropped from the record.
		const deposits = nodesPending(run).map(async (node) => {
			const at = run.nodes.findIndex((n) => n.id === node.id);
			let outcome: NodeOutcome;
			try {
				const share = run.nodeShares[at];
				if (!share) throw new Error('This node\'s share is no longer in the record.');
				const { staged } = await deps.deposit(node, { id: run.secretId!, version: run.version!, share });
				outcome = staged ? { state: 'staged' } : { state: 'held' };
			} catch (e) {
				if (e instanceof RunInterruptedError) throw e;
				outcome = { state: 'failed', error: (e as Error).message, at: deps.now() };
			}
			await step((r) => ({
				nodeOutcomes: { ...r.nodeOutcomes, [node.id]: outcome },
				...(outcome.state === 'failed' ? {} : { nodeShares: r.nodeShares.map((s, i) => (i === at ? null : s)) }),
			}));
		});
		// Shares go out one at a time, each recorded as it is captured; the
		// deposits run alongside. A send that fails still lets them land and be
		// recorded before the run stops.
		let sendError: unknown = null;
		try {
			for (const [i, g] of run.guardians.entries()) {
				if (run.sent[g.userHash]) continue;
				const messageId = await deps.sendShare(g.userHash, sharePartOf(run, i, ref, deps.now()));
				await step((r) => ({ sent: { ...r.sent, [g.userHash]: { messageId, shareIndex: i + 1 } } }));
			}
		} catch (e) {
			sendError = e;
		}
		const settled = await Promise.allSettled(deposits);
		if (sendError) throw sendError;
		const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
		if (failed) throw failed.reason;
		if (nodesPending(run).length) throw new RunStoppedError(run, 'nodes_failed', 'Some nodes did not take their part.');
		await step((r) => ({ step: 'done', ...scrubbed(r) }));
	}
	return run;
};

/** Finishing without the nodes still pending, when the rest reach the node threshold. */
export const skipPendingNodes = (run: BackupRun): BackupRun => {
	if (run.step !== 'registered' || !canFinishWithoutPending(run)) throw new Error('These nodes cannot be left out: too few others have their part.');
	return { ...run, skippedNodes: [...run.skippedNodes, ...nodesPending(run).map((n) => n.id)] };
};
