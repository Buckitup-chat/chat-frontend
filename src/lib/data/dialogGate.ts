// The verification gate between replicated dialog rows and trusted state.
//
// Electric delivering a row does not make it a message
// (invariants/02_integrity.md, 04_ordering.md): the row must verify against
// its author's card and its causal refs must resolve before anything treats
// it as ordered conversation. This module owns that admission for one dialog
// — per-row crypto lives in lib/pq, this layer adds the state: which
// revisions are in, who is waiting on whom, and re-admission when a missing
// dependency finally arrives.
//
// Verdicts: `verified` rows are trusted (with `dagVerified: false` when the
// sender's key is not available to decrypt refs — renderable, causally
// unplaced); `waiting` rows sit in a bounded queue keyed by what they miss —
// transient, the revision may still arrive; `blocked` rows cite a revision
// that can never be admitted — terminal, they are not left waiting forever;
// `invalid` rows are kept with their reason so the UI can surface rather than
// silently drop them.
import { verifyMessageRow, presentedRowFingerprint } from '@/lib/pq/verifyDialogRow';
import { validateRefs, revisionKey, type RevisionRef } from '@/lib/pq/dialogDag';
import type { DialogMessageRow, DialogMessageVersionRow } from '@/lib/data/types';

export type MessageLike = DialogMessageRow | DialogMessageVersionRow;

export type GateVerdict =
	| { status: 'verified'; dagVerified: boolean; isGenesis: boolean }
	| { status: 'waiting'; missing: RevisionRef[]; missingCard?: string }
	| { status: 'blocked'; blockedBy: RevisionRef[] }
	| { status: 'invalid'; reason: string; terminal: boolean };

const DEFINITIVE_INVALID = new Set(['self_reference', 'refs_decrypt_failed']);

export interface GateDeps {
	/** Verified sign_pkey (padded base64) for an author, or null when their card has not arrived/verified. */
	resolveSignPkey(userHash: string): Promise<string | null>;
	/**
	 * Decrypted refs map for a row. `no_key` — the sender's msg key is not
	 * derivable yet (not an error). `error` — key present but the blob does
	 * not decrypt, which a signed row can only reach through a sender bug.
	 */
	decryptRefs(row: MessageLike): Promise<Record<string, string> | 'no_key' | 'error'>;
	/** Waiting-queue cap; oldest entries are dropped past it. Default 500. */
	maxPending?: number;
	maxAwaitingCard?: number;
}

interface PendingEntry {
	row: MessageLike;
	refs: Record<string, string>;
	seq: number;
	blockedOnKeys: string[];
}

export function createDialogGate(deps: GateDeps) {
	const maxPending = deps.maxPending ?? 500;
	const maxAwaitingCard = deps.maxAwaitingCard ?? 500;

	const admitted = new Map<string, Map<string, { row: MessageLike; dagVerified: boolean }>>();
	const invalid = new Map<string, string>();
	const pending = new Map<string, PendingEntry>();
	/** missing reference key -> presented-keys of pending rows blocked on it. */
	const blockedOn = new Map<string, Set<string>>();
	/** author user_hash -> presented-key -> parked row (deduped: the read path
	 * may re-admit the same row on every sync tick while the card is absent) */
	const awaitingCard = new Map<string, Map<string, MessageLike>>();
	const terminal = new Map<string, string>();
	const blocked = new Map<string, RevisionRef[]>();
	let roots = 0;
	let seq = 0;

	const keyOf = (row: MessageLike) => revisionKey(row.message_id, row.sign_hash ?? '');
	const presentedKeyOf = (row: MessageLike) => `${keyOf(row)}::${presentedRowFingerprint(row as unknown as Record<string, unknown>)}`;
	const hasRevision = (key: string): boolean => (admitted.get(key)?.size ?? 0) > 0;

	const finishVerified = (row: MessageLike, dagVerified: boolean, isGenesis: boolean): GateVerdict => {
		const key = keyOf(row);
		const fingerprint = presentedRowFingerprint(row as unknown as Record<string, unknown>);
		let byFingerprint = admitted.get(key);
		if (!byFingerprint) {
			byFingerprint = new Map();
			admitted.set(key, byFingerprint);
		}
		if (!byFingerprint.has(fingerprint)) {
			byFingerprint.set(fingerprint, { row, dagVerified });
			if (isGenesis && byFingerprint.size === 1) roots++;
		}
		return { status: 'verified', dagVerified, isGenesis };
	};

	const finishInvalid = (row: MessageLike, reason: string): GateVerdict => {
		const key = keyOf(row);
		invalid.set(key, reason);
		const definitive = DEFINITIVE_INVALID.has(reason);
		if (definitive) markTerminal(key, reason);
		return { status: 'invalid', reason, terminal: definitive };
	};

	const finishBlocked = (row: MessageLike, blockedBy: RevisionRef[]): GateVerdict => {
		const key = keyOf(row);
		blocked.set(key, blockedBy);
		markTerminal(key, 'dependency_unadmittable');
		return { status: 'blocked', blockedBy };
	};

	const markTerminal = (key: string, reason: string): void => {
		if (terminal.has(key) || hasRevision(key)) return;
		terminal.set(key, reason);
		const dependents = blockedOn.get(key);
		if (!dependents) return;
		blockedOn.delete(key);
		for (const pKey of [...dependents]) {
			const entry = pending.get(pKey);
			if (!entry) continue;
			removePending(pKey);
			admitRefs(entry.row, entry.refs);
		}
	};

	const removePending = (pKey: string): void => {
		const entry = pending.get(pKey);
		if (!entry) return;
		pending.delete(pKey);
		for (const mk of entry.blockedOnKeys) {
			const set = blockedOn.get(mk);
			if (!set) continue;
			set.delete(pKey);
			if (set.size === 0) blockedOn.delete(mk);
		}
	};

	const parkPending = (row: MessageLike, refs: Record<string, string>, missing: RevisionRef[]): GateVerdict => {
		const pKey = presentedKeyOf(row);
		removePending(pKey);
		const blockedOnKeys = missing.map((m) => revisionKey(m.messageId, m.signHash));
		pending.set(pKey, { row, refs, seq: seq++, blockedOnKeys });
		for (const mk of blockedOnKeys) {
			if (!blockedOn.has(mk)) blockedOn.set(mk, new Set());
			blockedOn.get(mk)!.add(pKey);
		}
		// Bounded queue: an attacker can reference revisions that will never
		// exist; unbounded parking would let them grow memory forever.
		if (pending.size > maxPending) {
			let oldestKey: string | null = null;
			let oldestSeq = Infinity;
			for (const [k, e] of pending) if (e.seq < oldestSeq) { oldestSeq = e.seq; oldestKey = k; }
			if (oldestKey && oldestKey !== pKey) removePending(oldestKey);
		}
		return { status: 'waiting', missing };
	};

	/** DAG step for a row whose signature has already been checked. */
	const admitRefs = (row: MessageLike, refs: Record<string, string>): GateVerdict => {
		const verdict = validateRefs(
			{ messageId: row.message_id, signHash: row.sign_hash ?? '' },
			refs,
			{ hasRevision, isTerminal: (key) => terminal.has(key) },
		);
		if (verdict.status === 'violation') return finishInvalid(row, verdict.reason);
		if (verdict.status === 'blocked') return finishBlocked(row, verdict.blockedBy);
		if (verdict.status === 'waiting') return parkPending(row, refs, verdict.missing);
		return finishVerified(row, true, verdict.isGenesis);
	};

	/** Re-tries pending rows whose last missing dependency just landed.
	 * `landedKey` is a reference key (what blockedOn is keyed by). */
	const drainUnblocked = (landedKey: string) => {
		const blocked = blockedOn.get(landedKey);
		if (!blocked) return;
		blockedOn.delete(landedKey);
		for (const pKey of [...blocked]) {
			const entry = pending.get(pKey);
			if (!entry) continue;
			removePending(pKey);
			const verdict = admitRefs(entry.row, entry.refs);
			if (verdict.status === 'verified') drainUnblocked(keyOf(entry.row));
		}
	};

	const inFlight = new Map<string, Promise<GateVerdict>>();

	const admit = async (row: MessageLike): Promise<GateVerdict> => {
		const key = keyOf(row);
		const fingerprint = presentedRowFingerprint(row as unknown as Record<string, unknown>);
		const prior = admitted.get(key)?.get(fingerprint);
		if (prior) return { status: 'verified', dagVerified: prior.dagVerified, isGenesis: false };

		const pKey = `${key}::${fingerprint}`;
		const inflightAttempt = inFlight.get(pKey);
		if (inflightAttempt) return inflightAttempt;

		const attempt = admitOnce(row, key);
		inFlight.set(pKey, attempt);
		try {
			return await attempt;
		} finally {
			if (inFlight.get(pKey) === attempt) inFlight.delete(pKey);
		}
	};

	const admitOnce = async (row: MessageLike, key: string): Promise<GateVerdict> => {
		const signPkey = await deps.resolveSignPkey(row.sender_hash);
		if (!signPkey) {
			// The author's card is itself a replicated row that may simply not
			// have arrived. Park the message; onCardVerified re-admits it.
			const pKey = presentedKeyOf(row);
			const parked = awaitingCard.get(row.sender_hash) ?? new Map<string, MessageLike>();
			parked.delete(pKey);
			parked.set(pKey, row);
			if (parked.size > maxAwaitingCard) {
				const oldest = parked.keys().next().value;
				if (oldest !== undefined) parked.delete(oldest);
			}
			awaitingCard.set(row.sender_hash, parked);
			return { status: 'waiting', missing: [], missingCard: row.sender_hash };
		}

		const sig = verifyMessageRow(row, signPkey);
		if (sig.status === 'invalid') return finishInvalid(row, sig.reason);

		const refs = await deps.decryptRefs(row);
		if (refs === 'error') return finishInvalid(row, 'refs_decrypt_failed');
		if (refs === 'no_key') {
			// Signature holds but the causal map is unreadable without the
			// sender's key: trusted enough to render, not to order.
			const verdict = finishVerified(row, false, false);
			drainUnblocked(key); // children waiting on this revision can proceed
			return verdict;
		}

		const verdict = admitRefs(row, refs);
		if (verdict.status === 'verified') drainUnblocked(key);
		return verdict;
	};

	/** Call when an author's card verifies — re-admits rows parked on it. */
	const onCardVerified = async (userHash: string): Promise<void> => {
		const parked = awaitingCard.get(userHash);
		if (!parked) return;
		awaitingCard.delete(userHash);
		for (const row of parked.values()) await admit(row);
	};

	/** Re-admits everything parked on any card — cheap to call on each
	 * user_cards sync tick; rows whose card is still absent just re-park. */
	const retryAwaitingCards = async (): Promise<void> => {
		for (const userHash of [...awaitingCard.keys()]) await onCardVerified(userHash);
	};

	return {
		admit,
		onCardVerified,
		retryAwaitingCards,
		isAdmitted: (messageId: string, signHash: string) => hasRevision(revisionKey(messageId, signHash)),
		isRowAdmitted: (row: MessageLike) => !!admitted.get(keyOf(row))?.has(presentedRowFingerprint(row as unknown as Record<string, unknown>)),
		getInvalidReason: (messageId: string, signHash: string) => invalid.get(revisionKey(messageId, signHash)) ?? null,
		getBlockedBy: (messageId: string, signHash: string) => blocked.get(revisionKey(messageId, signHash)) ?? null,
		isTerminal: (messageId: string, signHash: string) => terminal.has(revisionKey(messageId, signHash)),
		stats: () => ({
			admitted: admitted.size,
			pending: pending.size,
			invalid: invalid.size,
			roots,
			blocked: blocked.size,
			blockedOnRefs: blockedOn.size,
			blockedOnEdges: [...blockedOn.values()].reduce((sum, set) => sum + set.size, 0),
			awaitingCard: [...awaitingCard.values()].reduce((sum, m) => sum + m.size, 0),
		}),
	};
}
