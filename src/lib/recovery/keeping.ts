// A guardian keeping the shares their contacts send, as actions over the
// guardian's own records (chat repo: pq_recovery_shares § Holding, § Dying).
// The copy lives in the guardian's `guardian` slot, under `holdings`: the
// message is not a place to keep it. Each change of where a share stands is
// told to the owner once, in the dialog it came in. The rules are
// holdings.ts'; this runs them against the slot, the dialog and the chain,
// which come in as functions.
import type { RecoveryHoldingPart } from '@/lib/pq/content';
import {
	classifyShare, conflictKey, holdingKey, holdsBytes, judgeShare, parseSecretRef, reportFor, shouldDrop, TOMBSTONES,
	type DyingContext, type Holding, type Holdings, type HoldingState, type KeepingContext, type ReceivedShare, type SecretOnChain,
} from './holdings';

export interface KeepingDeps {
	/** The holdings as the slot has them now. */
	load: () => Promise<Holdings>;
	/** Writes entries by key (the slot's keyed map); resolves to the holdings as the server accepted them. */
	save: (entries: Holdings) => Promise<Holdings>;
	/** dialogs.store sendMessage to the owner: resolves once captured durably. */
	send: (owner: string, parts: RecoveryHoldingPart[]) => Promise<unknown>;
	keeping: KeepingContext;
	dying: DyingContext;
	now: () => number;
}

/** `h` moved to `state`; a tombstone keeps the envelope and loses the share's bytes. */
const settle = (h: Holding, state: HoldingState, detail: string, now: number): Holding => ({
	...h,
	state,
	detail,
	updatedAt: now,
	...(TOMBSTONES.has(state) ? { share: { ...h.share, shareB64: '' } } : {}),
});

/** Whether any of `received` is new to `holdings`: what a dialog checks before taking the slot's lock. */
export const anyUnhandled = (owner: string, received: readonly ReceivedShare[], holdings: Holdings): boolean =>
	received.some((r) => classifyShare(owner, r, holdings) !== null);

/** A chain that did not answer leaves the holding as it is, to be read again. */
const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
	try {
		return await read();
	} catch (e) {
		console.warn('[recovery] a holding could not be checked now:', e);
		return null;
	}
};

/** Writes `entries` when there are any. */
const saveAny = async (deps: KeepingDeps, holdings: Holdings, entries: Holdings): Promise<Holdings> =>
	Object.keys(entries).length ? deps.save(entries) : holdings;

/**
 * Tells each owner what they have not heard yet, then marks what was told in
 * one write; a send that fails is tried again next time.
 */
const reportDue = async (deps: KeepingDeps, holdings: Holdings, keys: readonly string[] = Object.keys(holdings)): Promise<Holdings> => {
	const told: Holdings = {};
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
		told[key] = { ...h, reported: part.state as Holding['reported'] };
	}
	return saveAny(deps, holdings, told);
};

/**
 * Keeps the shares `owner` sent: the new ones are copied into the slot before
 * anything else — a share is never dropped on arrival — then judged against
 * the chain, and their states told to the owner. A refused one is recorded
 * without its bytes and reported.
 */
export const receiveShares = async (deps: KeepingDeps, owner: string, received: readonly ReceivedShare[]): Promise<Holdings> => {
	let holdings = await deps.load();
	const copies: Holdings = {};
	for (const r of received) {
		const verdict = classifyShare(owner, r, { ...holdings, ...copies });
		if (!verdict) continue;
		const base: Holding = { owner, share: r.share, messageId: r.messageId, state: 'pending', detail: '', updatedAt: deps.now() };
		if (verdict.kind === 'conflict') copies[conflictKey(owner, r)] = settle(base, 'conflict', verdict.reason, deps.now());
		else copies[holdingKey(owner, r.share)] = base;
	}
	holdings = await saveAny(deps, holdings, copies);
	const judged: Holdings = {};
	for (const [key, h] of Object.entries(copies)) {
		if (h.state !== 'pending') continue;
		const verdict = await orNull(() => judgeShare(owner, h.share, deps.keeping));
		if (verdict && verdict.state !== 'pending') judged[key] = settle(h, verdict.state, verdict.detail, deps.now());
	}
	holdings = await saveAny(deps, holdings, judged);
	return reportDue(deps, holdings, Object.keys(holdings).filter((k) => holdings[k].owner === owner));
};

/** Kept shares § Dying applies to: a pending one is judged again instead, an unreachable one is left alone. */
const DROPPABLE: ReadonlySet<HoldingState> = new Set(['stored', 'unverified', 'unrequested']);

/** The secrets the chain is asked about to tell whether a sweep has anything to do. */
export const secretsToCheck = (holdings: Holdings, reachable: (namespace: string) => boolean): string[] => {
	const ids = new Set<string>();
	for (const h of Object.values(holdings)) {
		const ref = DROPPABLE.has(h.state) ? parseSecretRef(h.share.secretRef) : null;
		if (ref && reachable(ref.namespace)) ids.add(ref.id);
	}
	return [...ids];
};

/**
 * Whether a sweep would change anything, from the holdings in memory and
 * the secrets read (secretsToCheck; a secret not read says nothing): a
 * pending share, a state not told yet, or a kept share whose secret was
 * revoked or moved past its version.
 */
export const sweepDue = (holdings: Holdings, secrets: ReadonlyMap<string, SecretOnChain | null>): boolean =>
	Object.values(holdings).some((h) => {
		if (h.state === 'pending' || reportFor(h)) return true;
		if (!DROPPABLE.has(h.state)) return false;
		const ref = parseSecretRef(h.share.secretRef);
		const secret = ref ? secrets.get(ref.id) : null;
		return !!secret && (secret.revoked || secret.version > h.share.version);
	});

/**
 * The periodic pass: a pending share is judged again once the chain shows
 * its version; a kept share on a deployment this build reaches is dropped
 * when § Dying says so. The changes go in one write, then whatever the owner
 * has not heard is told.
 */
export const sweepHoldings = async (deps: KeepingDeps): Promise<Holdings> => {
	let holdings = await deps.load();
	const changes: Holdings = {};
	for (const [key, h] of Object.entries(holdings)) {
		if (h.state === 'pending') {
			const verdict = await orNull(() => judgeShare(h.owner, h.share, deps.keeping));
			if (verdict && verdict.state !== 'pending') changes[key] = settle(h, verdict.state, verdict.detail, deps.now());
			continue;
		}
		if (!DROPPABLE.has(h.state)) continue;
		const ref = parseSecretRef(h.share.secretRef);
		if (!ref || !deps.keeping.reachable(ref.namespace)) continue;
		const reason = await orNull(() => shouldDrop(h, Object.values({ ...holdings, ...changes }), deps.dying));
		if (reason) changes[key] = settle(h, 'dropped', reason, deps.now());
	}
	holdings = await saveAny(deps, holdings, changes);
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
