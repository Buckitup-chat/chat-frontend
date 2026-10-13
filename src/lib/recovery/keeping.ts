// A guardian keeping the shares their contacts send, as actions over the
// guardian's own records (chat repo: pq_recovery_shares § Holding, § Dying).
// The copy lives in the guardian's `guardian` slot, under `holdings`, keyed
// by holdingKey: the message is not a place to keep it. Each change of where
// a share stands is told to the owner once, in the dialog it came in.
//
// The slot, the dialog and the chain come in as functions, so the rules here
// run the same against the app's stores and against a test's fakes.
import { getBytes } from 'ethers';
import { checkStealthAddress } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import type { RecoveryHoldingPart, RecoverySharePart } from '@/lib/pq/content';
import { conflictOf, holdingKey, judgeShare, parseSecretRef, reportOf, shouldDrop, type DyingContext, type Holding, type HoldingState, type KeepingContext, type SecretOnChain } from './holdings';
import { metaKeysOf } from './guardianInvite';
import type { GuardianAnswer } from './inviteThread';

/** The guardian slot's `holdings`: by holdingKey, or conflictKey for a share refused. */
export type Holdings = Record<string, Holding>;

export type ShareEnvelope = Omit<RecoverySharePart, 'kind'>;

/** A `recovery_share` from the dialog peer, with the message it came in. */
export interface ReceivedShare {
	messageId: string;
	share: ShareEnvelope;
}

export interface KeepingDeps {
	/** The holdings as the slot has them now. */
	load: () => Promise<Holdings>;
	/** Writes entries by key (the slot's keyed merge); resolves to the holdings as the server accepted them. */
	save: (entries: Holdings) => Promise<Holdings>;
	/** dialogs.store sendMessage to the owner: resolves once captured durably. */
	send: (owner: string, parts: RecoveryHoldingPart[]) => Promise<unknown>;
	keeping: KeepingContext;
	dying: DyingContext;
	now: () => number;
}

/** States in which the share's bytes are kept. */
const HELD: ReadonlySet<HoldingState> = new Set(['pending', 'stored', 'unverified', 'unreachable', 'unrequested']);
export const holdsBytes = (h: Holding): boolean => HELD.has(h.state);

/** Where the bytes are gone: dropped or given back. */
const TOMBSTONES: ReadonlySet<HoldingState> = new Set(['dropped', 'given_back']);

/** A refused share's key: beside the holding it disagrees with, never over it. */
export const conflictKey = (owner: string, messageId: string, share: ShareEnvelope): string => `${holdingKey(owner, share)}#${messageId}`;

/** `h` moved to `state`; a tombstone keeps the envelope and loses the share's bytes. */
const settle = (h: Holding, state: HoldingState, detail: string, now: number): Holding => ({
	...h,
	state,
	detail,
	updatedAt: now,
	...(TOMBSTONES.has(state) ? { share: { ...h.share, shareB64: '' } } : {}),
});

/**
 * What a received share is to the holdings, or null when it is already
 * handled: the same bytes kept under its key (a re-issue sends them again
 * in a later message), a tombstone there, or a refusal already recorded.
 * The same share with other bytes, or another split at a version held, is a
 * conflict: refused, and reported (§ Holding).
 */
export const classifyShare = (owner: string, r: ReceivedShare, holdings: Holdings): { kind: 'new' } | { kind: 'conflict'; reason: string } | null => {
	if (holdings[conflictKey(owner, r.messageId, r.share)]) return null;
	const same = holdings[holdingKey(owner, r.share)];
	if (same) {
		if (!holdsBytes(same) || same.share.shareB64 === r.share.shareB64) return null;
		return { kind: 'conflict', reason: 'this piece was already sent with different contents' };
	}
	const reason = conflictOf(r.share, Object.values(holdings).filter((h) => h.owner === owner && holdsBytes(h)));
	return reason ? { kind: 'conflict', reason } : { kind: 'new' };
};

/** Whether any of `received` is new to `holdings`: what a dialog checks before taking the slot's lock. */
export const anyUnhandled = (owner: string, received: readonly ReceivedShare[], holdings: Holdings): boolean =>
	received.some((r) => classifyShare(owner, r, holdings) !== null);

/**
 * The message telling the owner where `h` stands, or null when they already
 * know. A refused share is told as `unverified` with the reason: the owner's
 * client sent two pieces that cannot both be right.
 */
export const reportFor = (h: Holding): RecoveryHoldingPart | null => {
	if (h.state !== 'conflict') return reportOf(h);
	if (h.reported) return null;
	const { secretRef, version, splitId, shareIndex } = h.share;
	return { kind: 'recovery_holding', secretRef, version, splitId, shareIndex, state: 'unverified', detail: h.detail };
};

/** Tells each owner what they have not heard yet, one holding at a time; a send that fails is tried again next time. */
const reportDue = async (deps: KeepingDeps, holdings: Holdings, keys: readonly string[] = Object.keys(holdings)): Promise<Holdings> => {
	for (const key of keys) {
		const h = holdings[key];
		const part = h && reportFor(h);
		if (!part) continue;
		try {
			await deps.send(h.owner, [part]);
		} catch (e) {
			console.warn('[recovery] the holding report was not sent:', key, e);
			continue;
		}
		holdings = await deps.save({ [key]: { ...h, reported: part.state as Holding['reported'] } });
	}
	return holdings;
};

/** A chain that did not answer leaves the holding as it is, to be read again. */
const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
	try {
		return await read();
	} catch (e) {
		console.warn('[recovery] a holding could not be checked now:', e);
		return null;
	}
};

/**
 * Keeps the shares `owner` sent: each new one is copied into the slot before
 * anything else — a share is never dropped on arrival — then judged against
 * the chain, and its state told to the owner. A refused one is recorded
 * without its bytes and reported.
 */
export const receiveShares = async (deps: KeepingDeps, owner: string, received: readonly ReceivedShare[]): Promise<Holdings> => {
	let holdings = await deps.load();
	for (const r of received) {
		const verdict = classifyShare(owner, r, holdings);
		if (!verdict) continue;
		const base: Holding = { owner, share: r.share, messageId: r.messageId, state: 'pending', detail: '', updatedAt: deps.now() };
		if (verdict.kind === 'conflict') {
			const key = conflictKey(owner, r.messageId, r.share);
			holdings = await deps.save({ [key]: settle({ ...base, share: { ...r.share, shareB64: '' } }, 'conflict', verdict.reason, deps.now()) });
			continue;
		}
		const key = holdingKey(owner, r.share);
		holdings = await deps.save({ [key]: base });
		const judged = await orNull(() => judgeShare(owner, r.share, deps.keeping));
		if (judged && judged.state !== 'pending') holdings = await deps.save({ [key]: settle(base, judged.state, judged.detail, deps.now()) });
	}
	return reportDue(deps, holdings, Object.keys(holdings).filter((k) => holdings[k].owner === owner));
};

/** Holdings a sweep has something to do for. */
const DROPPABLE: ReadonlySet<HoldingState> = new Set(['stored', 'unverified', 'unrequested']);
export const needsSweep = (holdings: Holdings): boolean =>
	Object.values(holdings).some((h) => h.state === 'pending' || DROPPABLE.has(h.state) || reportFor(h) !== null);

/**
 * The periodic pass: a pending share is judged again once the chain shows
 * its version; a kept share on a deployment this build reaches is dropped
 * when § Dying says so; whatever the owner has not heard is told.
 */
export const sweepHoldings = async (deps: KeepingDeps): Promise<Holdings> => {
	let holdings = await deps.load();
	for (const key of Object.keys(holdings)) {
		const h = holdings[key];
		if (h.state === 'pending') {
			const judged = await orNull(() => judgeShare(h.owner, h.share, deps.keeping));
			if (judged && judged.state !== 'pending') holdings = await deps.save({ [key]: settle(h, judged.state, judged.detail, deps.now()) });
			continue;
		}
		if (!DROPPABLE.has(h.state)) continue;
		const ref = parseSecretRef(h.share.secretRef);
		if (!ref || !deps.keeping.reachable(ref.namespace)) continue;
		const reason = await orNull(() => shouldDrop(h, Object.values(holdings), deps.dying));
		if (reason) holdings = await deps.save({ [key]: settle(h, 'dropped', reason, deps.now()) });
	}
	return reportDue(deps, holdings);
};

export class GiveBackError extends Error {}

/**
 * Gives a kept share back (§ Holding): advisory — the contract still lists
 * this guardian, so the owner hears it as a prompt to reshare — and the copy
 * goes as a drop does.
 */
export const giveBack = async (deps: KeepingDeps, key: string): Promise<Holdings> => {
	const holdings = await deps.load();
	const h = holdings[key];
	if (!h || !holdsBytes(h)) throw new GiveBackError('This piece is no longer kept here.');
	return reportDue(deps, await deps.save({ [key]: settle(h, 'given_back', '', deps.now()) }), [key]);
};

// --- The guardian's own records and the chain ----------------------------------

/**
 * Whether this guardian's latest answer to `owner` for `namespace` is an
 * acceptance (§ Inviting, step 3): a decline at any time withdraws.
 */
export const consentedIn = (answers: Record<string, GuardianAnswer> | undefined, owner: string, namespace: string): boolean => {
	let latest: GuardianAnswer | null = null;
	for (const a of Object.values(answers ?? {})) {
		if (a.owner !== owner || a.deployment !== namespace) continue;
		if (!latest || (a.at ?? 0) > (latest.at ?? 0) || ((a.at ?? 0) === (latest.at ?? 0) && a.answer === 'decline')) latest = a;
	}
	return latest?.answer === 'accept';
};

/** The reads of RecoveryChain the guardian needs. */
export interface GuardianChain {
	readSecret: (id: string) => Promise<{ version: bigint; revoked: boolean } | null>;
	guardiansAt: (id: string, version: bigint) => Promise<string[]>;
	shareAt: (id: string, version: bigint, stealthAddress: string) => Promise<{ ephemeralPubKey: string; shareEncrypted: string }>;
}

/**
 * The chain as judgeShare and shouldDrop ask it, for one pass: each secret and
 * each version's slots are read once. A slot is this guardian's when their
 * viewing key derives the slot's address from its ephemeral key; without
 * the meta seed nothing is known, and nothing drops on it.
 */
export const chainContexts = (o: {
	chain: GuardianChain;
	namespace: string | null;
	answers: () => Record<string, GuardianAnswer> | undefined;
	metaSeed: () => Promise<string | null>;
}): { keeping: KeepingContext; dying: DyingContext } => {
	const secrets = new Map<string, Promise<SecretOnChain | null>>();
	const slots = new Map<string, Promise<{ address: string; ephemeralPubKey: string; shareEncrypted: string }[]>>();
	const readSecret = (id: string) => {
		let p = secrets.get(id);
		if (!p) {
			p = o.chain.readSecret(id).then((s) => (s ? { version: Number(s.version), revoked: s.revoked } : null));
			secrets.set(id, p);
			p.catch(() => secrets.delete(id));
		}
		return p;
	};
	const slotsOf = (id: string, version: number) => {
		const k = `${id}|${version}`;
		let p = slots.get(k);
		if (!p) {
			p = (async () => {
				const addresses = await o.chain.guardiansAt(id, BigInt(version));
				return Promise.all(addresses.map(async (address) => ({ address, ...(await o.chain.shareAt(id, BigInt(version), address)) })));
			})();
			slots.set(k, p);
			p.catch(() => slots.delete(k));
		}
		return p;
	};
	return {
		keeping: {
			reachable: (namespace) => o.namespace !== null && namespace === o.namespace,
			consented: (owner, namespace) => consentedIn(o.answers(), owner, namespace),
			readSecret,
			slotsAt: async (id, version) => (await slotsOf(id, version)).map((s) => getBytes(s.shareEncrypted)),
		},
		dying: {
			readSecret,
			addressedToMe: async (id, version) => {
				const listed = await slotsOf(id, version);
				if (!listed.length) return null;
				const seed = await o.metaSeed();
				if (!seed) return null;
				const keys = metaKeysOf(getBytes(seed.startsWith('0x') ? seed : `0x${seed}`));
				const scan = { viewingPrivateKey: keys.viewingPrivateKey, spendingPublicKey: '0x' + keys.metaAddress.slice(2, 68) };
				return listed.some((s) => checkStealthAddress(scan, s.ephemeralPubKey)?.toLowerCase() === s.address.toLowerCase());
			},
		},
	};
};
