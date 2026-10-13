// One look at a recovery in progress, from the temporary account (chat repo:
// pq_recovery_shares § Returning, steps 3–6; plan § 7.5): answer every
// guardian's request with a binding, follow the round on chain for this
// device's candidate, judge each returned share against the version's root,
// and — once this device may decrypt — ask the nodes the shares name for
// the node half. The dialogs, the chain and the nodes come in as functions,
// so a test drives a whole recovery with fakes that keep their contract.
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import type { ContentPart, RecoveryShareReturnPart } from '@/lib/pq/content';
import { guardianChainReads, type SecretState } from './chain';
import { parseSecretRef } from './holdings';
import { NodeError, type NodeRef } from './nodeClient';
import { assembleWrapKey, usableNodeShares } from './recovering';
import { recoveryWords } from './recoveryBinding';
import {
	bindingFor,
	candidateOf,
	chosenSecret,
	findSecretRef,
	judgeReturns,
	newCandidateKey,
	nodesOf,
	roundViewOf,
	type HelpRequest,
	type ReceivedReturn,
	type ReturnsJudged,
	type RoundView,
} from './restoring';
import { rootFromSlots } from './shareSplit';

/** What a recovery keeps on the temporary account's device, sealed in its vault. Never sent anywhere. */
export interface RestoreProgress {
	v: 1;
	/** The temporary account. */
	userHash: string;
	/** `0x` hex. Destroyed with the temporary account; a restart replaces it. */
	candidateKey: string;
	/** Bindings sent: `<peer>|<secret_ref>` → the candidate they named. */
	answered: Record<string, string>;
	/** The last round this device saw open for its candidate's secret: the same round back at None was vetoed. */
	seenRound: number | null;
	/** A secret_ref the person typed in from a guardian outside the app (§ Manual return), with when. */
	typedRequests: { secretRef: string; at: number }[];
	/** Shares returned as text, opened after the six digits matched. */
	typedReturns: { sender: string; part: RecoveryShareReturnPart }[];
	startedAt: number;
}

export const newProgress = (userHash: string, now: number): RestoreProgress => ({
	v: 1,
	userHash,
	candidateKey: newCandidateKey(),
	answered: {},
	seenRound: null,
	typedRequests: [],
	typedReturns: [],
	startedAt: now,
});

/**
 * The same recovery with a fresh candidate key (§ Returning: after the window
 * closes, from step 3): every guardian is answered again, and what came back
 * for the old candidate no longer counts.
 */
export const restarted = (p: RestoreProgress): RestoreProgress => ({ ...p, candidateKey: newCandidateKey(), answered: {}, seenRound: null, typedReturns: [] });

/** The chain reads a recovery makes. */
export interface RestoreChain {
	readSecret: (id: string) => Promise<SecretState | null>;
	roundState: (id: string) => Promise<RoundState>;
	guardiansAt: (id: string, version: bigint) => Promise<string[]>;
	shareAt: (id: string, version: bigint, stealthAddress: string) => Promise<{ ephemeralPubKey: string; shareEncrypted: string }>;
	hasApproved: (id: string, candidate: string, guardian: string) => Promise<boolean>;
	canDecrypt: (account: string, id: string) => Promise<boolean>;
}

export interface RestoreDeps {
	/** The namespace (`eip155:<chain>:<contract>`) this build reaches; null when it names none. */
	namespace: string | null;
	/** Who opened a dialog with the temporary account: each once, not the account itself. */
	peersWhoWrote: () => Promise<string[]>;
	/** A peer's messages with text and returned shares, oldest first; null when the dialog could not be read now. */
	readPeer: (peer: string) => Promise<{ messageId: string; parts: ContentPart[] }[] | null>;
	sendBinding: (peer: string, parts: ContentPart[]) => Promise<void>;
	chain: RestoreChain;
	/** A node's release for secret `id`, opened with the candidate key (nodeClient.requestRelease). */
	release: (node: NodeRef, id: string, candidateKey: string) => Promise<{ version: number; share: string }>;
	save: (p: RestoreProgress) => Promise<void>;
	now: () => number;
}

/**
 * What one pass learnt that the next keeps in memory — what cannot change:
 * a version's guardians and root (none, too: slots are written once),
 * approvals recorded in a round, and the nodes' answers for this candidate.
 */
export interface RestoreMemo {
	/** By `<id>|<version>`. */
	guardians: Map<string, string[]>;
	/** By `<id>|<version>`; null when the version's slots carry none. */
	roots: Map<string, Uint8Array | null>;
	/** `<round>|<candidate>|<guardian>` of every approval seen. */
	approved: Set<string>;
	/** By `<secret id>|<candidate>|<node id>`. */
	releases: Map<string, { version: number; share: string }>;
	/** By `<secret id>|<candidate>|<node id>`: why it did not release, and when it was last asked. */
	nodeFailures: Map<string, { reason: string; at: number }>;
}

export const newMemo = (): RestoreMemo => ({ guardians: new Map(), roots: new Map(), approved: new Set(), releases: new Map(), nodeFailures: new Map() });

/** A node that did not release is asked again after this long. */
export const NODE_RETRY_SEC = 60;

export type NodeStatus = { node: NodeRef; state: 'waiting' | 'released' | 'failed'; detail?: string };

export interface RestoreView {
	candidate: string;
	/** The guardians' requests, the typed ones as peer `null`. */
	requests: (Omit<HelpRequest, 'peer'> & { peer: string | null })[];
	/** The backup this recovery follows, once a guardian asked. */
	secretRef: string | null;
	/** The ten words to read out, once there is a secret to bind to. */
	words: string[] | null;
	/** Why the recovery cannot go on from here, if it cannot. */
	problem: string | null;
	round: RoundView | null;
	/** The backup version the round runs on: the only one whose shares count. */
	version: number | null;
	/** Approvals of this candidate recorded, while voting. */
	approvals: number | null;
	returns: ReturnsJudged | null;
	nodes: NodeStatus[];
	/** Node shares that combine: one per x-coordinate. */
	nodeShares: number;
	/** Enough of both halves to put S together. */
	ready: boolean;
}

const emptyView = (candidate: string): RestoreView => ({
	candidate,
	requests: [],
	secretRef: null,
	words: null,
	problem: null,
	round: null,
	version: null,
	approvals: null,
	returns: null,
	nodes: [],
	nodeShares: 0,
	ready: false,
});

const isReturn = (p: ContentPart): p is RecoveryShareReturnPart => p.kind === 'recovery_share_return';

/** A node's answer for one secret and one candidate: node ids are not per secret, and a recovery may follow another backup. */
const releaseKey = (id: string, candidate: string, node: NodeRef) => `${id.toLowerCase()}|${candidate}|${node.id}`;

/** The releases this candidate holds for secret `id`, from the nodes the set names, at the round's version. */
const releasesFor = (memo: RestoreMemo, id: string, candidate: string, nodes: NodeRef[], version: number) =>
	nodes.map((n) => memo.releases.get(releaseKey(id, candidate, n))).filter((r): r is { version: number; share: string } => !!r && r.version === version);

/**
 * One pass. Resolves to the progress — saved when it changed — and what the
 * screen shows. A chain that does not answer throws: the screen keeps the
 * last view and says it could not look.
 */
export const restorePass = async (progress: RestoreProgress, deps: RestoreDeps, memo: RestoreMemo): Promise<{ progress: RestoreProgress; view: RestoreView }> => {
	let p = progress;
	const candidate = candidateOf(p.candidateKey);
	const view = emptyView(candidate);
	const me = p.userHash;

	// Requests and returns, from every dialog a guardian opened.
	const received: ReceivedReturn[] = p.typedReturns.map((r) => ({ sender: r.sender, via: 'text' as const, part: r.part }));
	const requests: HelpRequest[] = [];
	await Promise.all(
		(await deps.peersWhoWrote()).map(async (peer) => {
			const messages = await deps.readPeer(peer);
			for (const m of messages ?? []) {
				for (const part of m.parts) {
					if (part.kind === 'text') {
						const ref = findSecretRef(part.text);
						if (ref) requests.push({ peer, secretRef: ref, messageId: m.messageId });
					} else if (isReturn(part)) received.push({ sender: peer, via: 'dialog', part });
				}
			}
		}),
	);
	const typed = p.typedRequests.map((t, i) => ({ peer: `typed:${i}`, secretRef: t.secretRef, messageId: `typed:${t.at}` }));
	view.requests = [...requests.sort((a, b) => (a.messageId < b.messageId ? -1 : 1)), ...typed.map((t) => ({ ...t, peer: null }))];

	// Every guardian is answered for the backup they asked about, once per candidate.
	const answered = { ...p.answered };
	let changed = false;
	const newest = new Map<string, HelpRequest>();
	for (const r of requests) newest.set(`${r.peer}|${r.secretRef}`, r);
	for (const [key, r] of newest) {
		if (answered[key] === candidate) continue;
		await deps.sendBinding(r.peer, [bindingFor(p.candidateKey, r.secretRef, me)]);
		answered[key] = candidate;
		changed = true;
	}
	if (changed) {
		p = { ...p, answered };
		await deps.save(p);
	}

	const secretRef = chosenSecret([...requests, ...typed]);
	view.secretRef = secretRef;
	if (!secretRef) return { progress: p, view };
	view.words = recoveryWords(secretRef, candidate, me);
	const ref = parseSecretRef(secretRef)!;
	if (ref.namespace !== deps.namespace) {
		view.problem = 'This backup is on a network this app does not reach.';
		return { progress: p, view };
	}

	// The round, for this candidate.
	const [secret, state] = await Promise.all([deps.chain.readSecret(ref.id), deps.chain.roundState(ref.id)]);
	if (!secret) {
		view.problem = 'The network holds no backup by that name: check what your guardian sent.';
		return { progress: p, view };
	}
	if (secret.revoked) {
		view.problem = 'This backup was revoked: it cannot be recovered.';
		return { progress: p, view };
	}
	const now = deps.now();
	const round = roundViewOf(secret, state, candidate, p.seenRound, now);
	view.round = round;
	if (state !== RoundState.None && p.seenRound !== round.round) {
		p = { ...p, seenRound: round.round };
		await deps.save(p);
	}
	const version = Number(secret.version);
	view.version = version;
	const versionKey = `${ref.id}|${version}`;
	const guardiansOf = async () => {
		if (!memo.guardians.has(versionKey)) memo.guardians.set(versionKey, await deps.chain.guardiansAt(ref.id, secret.version));
		return memo.guardians.get(versionKey)!;
	};
	if (round.phase === 'voting') {
		// An approval cannot be taken back within its round: one seen is not asked again.
		const votes = await Promise.all(
			(await guardiansOf()).map(async (g) => {
				const key = `${round.round}|${candidate}|${g}`;
				if (memo.approved.has(key)) return true;
				const yes = await deps.chain.hasApproved(ref.id, candidate, g);
				if (yes) memo.approved.add(key);
				return yes;
			}),
		);
		view.approvals = votes.filter(Boolean).length;
	}

	// The returns, against the root of the version the round runs on.
	if (!memo.roots.has(versionKey)) {
		const reads = guardianChainReads({ ...deps.chain, guardiansAt: guardiansOf }, async () => null);
		memo.roots.set(versionKey, rootFromSlots(await reads.slotsAt(ref.id, version)));
	}
	const returns = judgeReturns(received, { secretRef, version, round: round.round, candidate }, memo.roots.get(versionKey) ?? null);
	view.returns = returns;

	// The node half, from the set the verified shares name, once this device may decrypt.
	const nodes = nodesOf(returns.nodeSet);
	const usable = () => usableNodeShares(releasesFor(memo, ref.id, candidate, nodes, version).map((r) => r.share)).shares.length;
	if (nodes.length && round.phase === 'window' && usable() < returns.nodeSet!.threshold && (await deps.chain.canDecrypt(candidate, ref.id))) {
		// All of them, in the set's order, until the node threshold: the spares count.
		for (const node of nodes) {
			if (usable() >= returns.nodeSet!.threshold) break;
			const key = releaseKey(ref.id, candidate, node);
			if (memo.releases.has(key)) continue;
			const failed = memo.nodeFailures.get(key);
			if (failed && now - failed.at < NODE_RETRY_SEC) continue;
			try {
				const released = await deps.release(node, ref.id, p.candidateKey);
				if (released.version !== version) {
					memo.nodeFailures.set(key, { reason: `it holds version ${released.version}, not ${version}`, at: now });
					continue;
				}
				memo.releases.set(key, released);
				memo.nodeFailures.delete(key);
			} catch (e) {
				if (!(e instanceof NodeError)) throw e;
				memo.nodeFailures.set(key, { reason: e.status === 0 ? 'it does not answer' : e.status === 403 ? 'not yet' : e.message, at: now });
			}
		}
	}
	view.nodes = nodes.map((node) => {
		const key = releaseKey(ref.id, candidate, node);
		const released = memo.releases.get(key);
		if (released && released.version === version) return { node, state: 'released' as const };
		const failed = memo.nodeFailures.get(key);
		return failed ? { node, state: 'failed' as const, detail: failed.reason } : { node, state: 'waiting' as const };
	});
	view.nodeShares = usable();
	view.ready = !!returns.threshold && returns.distinct >= returns.threshold && !!returns.nodeSet && view.nodeShares >= returns.nodeSet.threshold;
	return { progress: p, view };
};

/** S, from what the last pass found enough of; throws ShareCheckError when it does not combine. */
export const wrapKeyFrom = (view: RestoreView, memo: RestoreMemo): Uint8Array => {
	if (!view.returns || view.version === null || !view.secretRef) throw new Error('no returned shares');
	const releases = releasesFor(memo, parseSecretRef(view.secretRef)!.id, view.candidate, view.nodes.map((n) => n.node), view.version);
	return assembleWrapKey(
		view.returns.verified.map((v) => v.checked),
		releases.map((r) => r.share),
	);
};
