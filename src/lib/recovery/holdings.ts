// A guardian keeping the shares they were sent, and the owner reading back
// where each one stands (chat repo: pq_recovery_shares § Holding, § Dying;
// 07 § recovery_share, § recovery_holding). Pure: the chain and the
// guardian's own records come in as functions, and the answers go out as
// states the screens show and the dialog carries.
import { fromBase64 } from '@/lib/pq/signature';
import type { RecoveryHoldingPart, RecoverySharePart } from '@/lib/pq/content';
import { checkShare, rootFromSlots, ShareCheckError } from './shareSplit';

/** What a holding can be. `pending`: the chain does not show its version yet; `conflict`: refused, it disagrees with one already kept. */
export type HoldingState = 'pending' | 'stored' | 'unverified' | 'unreachable' | 'unrequested' | 'given_back' | 'dropped' | 'conflict';

/** The states a guardian tells the owner (07 § recovery_holding). */
export const REPORTED_STATES = ['stored', 'unverified', 'unreachable', 'unrequested', 'given_back', 'dropped'] as const;
export type ReportedState = (typeof REPORTED_STATES)[number];

/** One share the guardian keeps, envelope whole: a return reproduces what was issued. */
export interface Holding {
	/** The dialog peer who sent it: the holding is their claim (§ Holding). */
	owner: string;
	share: Omit<RecoverySharePart, 'kind'>;
	/** The message it came in. */
	messageId: string;
	state: HoldingState;
	detail: string;
	/** The last state told to the owner, so each change is told once. */
	reported?: ReportedState;
	updatedAt: number;
}

/** `<owner>|<secret_ref>|<version>|<split_id>|<share_index>`: what a guardian may hold once. */
export const holdingKey = (owner: string, s: Pick<RecoverySharePart, 'secretRef' | 'version' | 'splitId' | 'shareIndex'>): string =>
	`${owner}|${s.secretRef}|${s.version}|${s.splitId}|${s.shareIndex}`;

/** `<namespace>/<id>` → its parts, or null when it is not that shape. */
export const parseSecretRef = (ref: string): { namespace: string; id: string } | null => {
	const at = ref.lastIndexOf('/');
	if (at <= 0) return null;
	const id = ref.slice(at + 1);
	return /^0x[0-9a-f]{64}$/.test(id) ? { namespace: ref.slice(0, at), id } : null;
};

export interface SecretOnChain {
	version: number;
	revoked: boolean;
}

export interface KeepingContext {
	/** Whether this build reaches the deployment `namespace` names. */
	reachable: (namespace: string) => boolean;
	/** Whether this guardian's own records hold a live acceptance to `owner` for `namespace` (§ Inviting, step 3). */
	consented: (owner: string, namespace: string) => boolean;
	/** The secret on chain, null when there is none; throws when the chain does not answer. */
	readSecret: (id: string) => Promise<SecretOnChain | null>;
	/** The guardian slots' `shareEncrypted` bytes at `version`, empty while none are listed. */
	slotsAt: (id: string, version: number) => Promise<Uint8Array[]>;
}

/**
 * Where a share just received stands. It is kept whatever the answer — a
 * share is never dropped on arrival — and every state but `pending` is told
 * to the owner: a share that does not verify may be the owner's client's
 * fault, and the owner has to hear it. The detail travels to the owner, so it
 * names "the guardian" rather than "you".
 */
export const judgeShare = async (owner: string, share: Omit<RecoverySharePart, 'kind'>, ctx: KeepingContext): Promise<{ state: HoldingState; detail: string }> => {
	const ref = parseSecretRef(share.secretRef);
	if (!ref) return { state: 'unverified', detail: 'it names no secret the guardian\'s app can read' };
	if (!ctx.reachable(ref.namespace)) return { state: 'unreachable', detail: 'it is for a network the guardian\'s app cannot reach' };
	if (!ctx.consented(owner, ref.namespace)) return { state: 'unrequested', detail: 'the guardian has not agreed to keep pieces on this network' };
	const secret = await ctx.readSecret(ref.id);
	// A version the chain does not show yet is read again later, not reported.
	if (!secret || share.version > secret.version) return { state: 'pending', detail: '' };
	if (secret.revoked) return { state: 'dropped', detail: 'the backup was revoked' };
	const slots = await ctx.slotsAt(ref.id, share.version);
	if (!slots.length) return { state: 'pending', detail: '' };
	const root = rootFromSlots(slots);
	if (!root) return { state: 'unverified', detail: 'the network holds no checksum for this version' };
	try {
		checkShare(
			{
				splitId: share.splitId,
				threshold: share.threshold,
				total: share.total,
				index: share.shareIndex,
				share: fromBase64(share.shareB64),
				proof: share.splitProof.map((leaf) => fromBase64(leaf)),
				nodeSet: share.nodeSet,
			},
			root,
		);
	} catch (e) {
		if (e instanceof ShareCheckError) return { state: 'unverified', detail: e.message };
		throw e;
	}
	return { state: 'stored', detail: '' };
};

/**
 * Whether `incoming` may be kept beside `held` (every holding from the same
 * owner). Several shares of one split are fine — a spare handed to an
 * existing guardian is a second index. The same share with other bytes is
 * refused, and so is another split at a version already held: both are faults
 * to report, not shares to keep (§ Holding).
 */
export const conflictOf = (incoming: Omit<RecoverySharePart, 'kind'>, held: readonly Holding[]): string | null => {
	for (const h of held) {
		const s = h.share;
		if (s.secretRef !== incoming.secretRef || s.version !== incoming.version) continue;
		if (s.splitId !== incoming.splitId) return 'another split was already sent for this version';
		if (s.shareIndex === incoming.shareIndex && s.shareB64 !== incoming.shareB64) return 'this piece was already sent with different contents';
	}
	return null;
};

export interface DyingContext {
	readSecret: KeepingContext['readSecret'];
	/**
	 * Whether a guardian slot of `version` is addressed to this guardian — their
	 * viewing key recognises it — or null when the slots are not listed yet.
	 */
	addressedToMe: (id: string, version: number) => Promise<boolean | null>;
}

/**
 * Whether a kept share has stopped being valid (§ Dying): revoked, or
 * superseded once its replacement is held or the new version has no slot for
 * this guardian. Never on the version bump alone — a retained guardian who
 * dropped before the replacement arrived would hold nothing — and never by
 * age.
 */
export const shouldDrop = async (h: Holding, all: readonly Holding[], ctx: DyingContext): Promise<string | null> => {
	const ref = parseSecretRef(h.share.secretRef);
	if (!ref) return null;
	const secret = await ctx.readSecret(ref.id);
	if (!secret) return null;
	if (secret.revoked) return 'the backup was revoked';
	if (secret.version <= h.share.version) return null;
	const replaced = all.some(
		(o) => o.owner === h.owner && o.share.secretRef === h.share.secretRef && o.share.version === secret.version && o.state === 'stored',
	);
	if (replaced) return 'a newer version replaced it';
	const mine = await ctx.addressedToMe(ref.id, secret.version);
	return mine === false ? 'the backup no longer lists this guardian' : null;
};

/** The message telling the owner where `h` stands, or null when they already know. */
export const reportOf = (h: Holding): RecoveryHoldingPart | null => {
	if (!(REPORTED_STATES as readonly string[]).includes(h.state) || h.reported === h.state) return null;
	const { secretRef, version, splitId, shareIndex } = h.share;
	return { kind: 'recovery_holding', secretRef, version, splitId, shareIndex, state: h.state, detail: h.state === 'stored' ? '' : h.detail };
};

/**
 * The owner's side: each guardian's latest word on the share they were sent,
 * with its reason, from their `recovery_holding` messages in dialog order.
 * Only the guardian the share went to can state it, and only about that share.
 */
export const holdingReportsOf = (
	messages: readonly { senderHash: string; parts: readonly { kind: string }[] }[],
	sent: Record<string, { secretRef: string; version: number; splitId: string; shareIndex: number }>,
): Record<string, { state: ReportedState; detail: string }> => {
	const out: Record<string, { state: ReportedState; detail: string }> = {};
	for (const m of messages) {
		const expected = sent[m.senderHash];
		if (!expected) continue;
		for (const p of m.parts) {
			if (p.kind !== 'recovery_holding') continue;
			const r = p as RecoveryHoldingPart;
			if (r.secretRef !== expected.secretRef || r.version !== expected.version || r.splitId !== expected.splitId || r.shareIndex !== expected.shareIndex) continue;
			if ((REPORTED_STATES as readonly string[]).includes(r.state)) out[m.senderHash] = { state: r.state as ReportedState, detail: r.detail };
		}
	}
	return out;
};

/** holdingReportsOf, the states alone. */
export const holdingStatesOf = (...args: Parameters<typeof holdingReportsOf>): Record<string, ReportedState> =>
	Object.fromEntries(Object.entries(holdingReportsOf(...args)).map(([guardian, r]) => [guardian, r.state]));
