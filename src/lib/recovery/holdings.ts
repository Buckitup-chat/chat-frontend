// What a guardian keeps of the shares they were sent (chat repo:
// pq_recovery_shares § Holding, § Dying; 07 § recovery_share,
// § recovery_holding): the holding record and its keys, where a received
// share stands against the chain and against what is already kept, when a
// kept one dies, and what the owner is told. Pure: the chain and the
// guardian's records come in as functions and values.
import { fromBase64 } from '@/lib/pq/signature';
import type { RecoveryHoldingPart, RecoverySharePart } from '@/lib/pq/content';
import { checkShare, rootFromSlots, ShareCheckError } from './shareSplit';

/** A `recovery_share` envelope, whole: a return reproduces what was issued. */
export type ShareEnvelope = Omit<RecoverySharePart, 'kind'>;

/** What a holding can be. `pending`: the chain does not show its version yet; `conflict`: refused, it disagrees with one already kept. */
export type HoldingState = 'pending' | 'stored' | 'unverified' | 'unreachable' | 'unrequested' | 'given_back' | 'dropped' | 'conflict';

/** The states a guardian tells the owner (07 § recovery_holding). */
export const REPORTED_STATES = ['stored', 'unverified', 'unreachable', 'unrequested', 'given_back', 'dropped'] as const;
export type ReportedState = (typeof REPORTED_STATES)[number];
export const isReportedState = (state: string): state is ReportedState => (REPORTED_STATES as readonly string[]).includes(state);

/** One share the guardian keeps, or kept. */
export interface Holding {
	/** The dialog peer who sent it: the holding is their claim (§ Holding). */
	owner: string;
	/** The envelope; a tombstone's has no `shareB64`. */
	share: ShareEnvelope;
	/** The message it came in. */
	messageId: string;
	state: HoldingState;
	detail: string;
	/** The last state told to the owner, so each change is told once. */
	reported?: ReportedState;
	updatedAt: number;
}

/** The guardian slot's `holdings`: by holdingKey, or conflictKey for a share refused. */
export type Holdings = Record<string, Holding>;

/** A `recovery_share` from the dialog peer, with the message it came in. */
export interface ReceivedShare {
	messageId: string;
	share: ShareEnvelope;
}

/** `<owner>|<secret_ref>|<version>|<split_id>|<share_index>`: what a guardian may hold once. */
export const holdingKey = (owner: string, s: Pick<ShareEnvelope, 'secretRef' | 'version' | 'splitId' | 'shareIndex'>): string =>
	`${owner}|${s.secretRef}|${s.version}|${s.splitId}|${s.shareIndex}`;

/** A refused share's key: beside the holding it disagrees with, never over it. */
export const conflictKey = (owner: string, r: ReceivedShare): string => `${holdingKey(owner, r.share)}#${r.messageId}`;

/** States in which the share's bytes are kept. */
const HELD: ReadonlySet<HoldingState> = new Set(['pending', 'stored', 'unverified', 'unreachable', 'unrequested']);
export const holdsBytes = (h: Holding): boolean => HELD.has(h.state);

/** States kept without the bytes: dropped, given back, refused. */
export const TOMBSTONES: ReadonlySet<HoldingState> = new Set(['dropped', 'given_back', 'conflict']);

/**
 * The holding a received share stands for, with its key: its refusal, or the
 * holding of the same share — unless that one keeps other bytes, which makes
 * this share a refusal not recorded yet. Null when there is none.
 */
export const holdingFor = (owner: string, r: ReceivedShare, holdings: Holdings): { key: string; holding: Holding } | null => {
	const refusal = conflictKey(owner, r);
	if (holdings[refusal]) return { key: refusal, holding: holdings[refusal] };
	const key = holdingKey(owner, r.share);
	const held = holdings[key];
	if (!held || (holdsBytes(held) && held.share.shareB64 !== r.share.shareB64)) return null;
	return { key, holding: held };
};

/**
 * What a received share is to the holdings, or null when it is already
 * handled — the same bytes kept under its key (a re-issue sends them again in
 * a later message), a tombstone there, or its refusal recorded. Several
 * shares of one split are fine: a spare handed to an existing guardian is a
 * second index. The same share with other bytes, or another split at a
 * version held, is a fault to report, not a share to keep (§ Holding).
 */
export const classifyShare = (owner: string, r: ReceivedShare, holdings: Holdings): { kind: 'new' } | { kind: 'conflict'; reason: string } | null => {
	if (holdingFor(owner, r, holdings)) return null;
	if (holdings[holdingKey(owner, r.share)]) return { kind: 'conflict', reason: 'this piece was already sent with different contents' };
	const { secretRef, version, splitId } = r.share;
	const otherSplit = Object.values(holdings).some(
		(h) => h.owner === owner && holdsBytes(h) && h.share.secretRef === secretRef && h.share.version === version && h.share.splitId !== splitId,
	);
	return otherSplit ? { kind: 'conflict', reason: 'another split was already sent for this version' } : { kind: 'new' };
};

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

/** Why a share kept without the guardian's live acceptance is reported. */
export const UNREQUESTED = 'the guardian has not agreed to keep pieces on this network';

/**
 * Where a share just received stands. It is kept whatever the answer — a
 * share is never dropped on arrival — and every state but `pending` is told
 * to the owner: a share that does not verify may be the owner's client's
 * fault, and the owner has to hear it. The detail travels to the owner, so it
 * names "the guardian" rather than "you".
 */
export const judgeShare = async (owner: string, share: ShareEnvelope, ctx: KeepingContext): Promise<{ state: HoldingState; detail: string }> => {
	const ref = parseSecretRef(share.secretRef);
	if (!ref) return { state: 'unverified', detail: 'it names no secret the guardian\'s app can read' };
	if (!ctx.reachable(ref.namespace)) return { state: 'unreachable', detail: 'it is for a network the guardian\'s app cannot reach' };
	if (!ctx.consented(owner, ref.namespace)) return { state: 'unrequested', detail: UNREQUESTED };
	// Bytes that do not decode are the piece's fault, whatever the chain says.
	let piece: Uint8Array;
	let proof: Uint8Array[];
	try {
		piece = fromBase64(share.shareB64);
		proof = share.splitProof.map((leaf) => fromBase64(leaf));
	} catch {
		return { state: 'unverified', detail: 'the piece is not valid base64' };
	}
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
				share: piece,
				proof,
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

/**
 * The message telling the owner where `h` stands, or null when there is
 * nothing to tell yet (pending) or they already know. A refused share is told
 * as `unverified` with the reason — the owner's client sent two pieces that
 * cannot both be right — unless `holdings` keeps a holding under the same
 * key: the owner's latest word on a piece is that holding's, so a refusal of
 * other bytes for it stays with the guardian (the chat shows it), and only a
 * refusal with no holding at its key, another split, is told.
 */
export const reportFor = (h: Holding, holdings: Holdings = {}): RecoveryHoldingPart | null => {
	if (h.state === 'conflict' && holdings[holdingKey(h.owner, h.share)]) return null;
	const state: ReportedState | null = h.state === 'conflict' ? 'unverified' : isReportedState(h.state) ? h.state : null;
	if (!state || h.reported === state) return null;
	const { secretRef, version, splitId, shareIndex } = h.share;
	return { kind: 'recovery_holding', secretRef, version, splitId, shareIndex, state, detail: state === 'stored' ? '' : h.detail };
};
