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
// unplaced); `waiting` rows sit in a bounded queue keyed by what they miss;
// `invalid` rows are kept with their reason so the UI can surface rather than
// silently drop them.

import { verifyMessageRow } from '@/lib/pq/verifyDialogRow';
import { validateRefs, revisionKey, type RevisionRef } from '@/lib/pq/dialogDag';
import type { DialogMessageRow, DialogMessageVersionRow } from '@/lib/data/types';

export type MessageLike = DialogMessageRow | DialogMessageVersionRow;

export type GateVerdict =
	| { status: 'verified'; dagVerified: boolean; isGenesis: boolean }
	| { status: 'waiting'; missing: RevisionRef[]; missingCard?: string }
	| { status: 'invalid'; reason: string };

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
}

interface PendingEntry {
	row: MessageLike;
	refs: Record<string, string>;
	seq: number;
}

export function createDialogGate(deps: GateDeps) {
	const maxPending = deps.maxPending ?? 500;

	const admitted = new Map<string, { row: MessageLike; dagVerified: boolean }>();
	const invalid = new Map<string, string>();
	const pending = new Map<string, PendingEntry>();
	/** missing revisionKey → keys of pending rows blocked on it */
	const blockedOn = new Map<string, Set<string>>();
	/** author user_hash → parked rows by revision key (deduped: the read path
	 * may re-admit the same row on every sync tick while the card is absent) */
	const awaitingCard = new Map<string, Map<string, MessageLike>>();
	let genesisSeen = false;
	let seq = 0;

	const keyOf = (row: MessageLike) => revisionKey(row.message_id, row.sign_hash ?? '');

	const finishVerified = (row: MessageLike, dagVerified: boolean, isGenesis: boolean): GateVerdict => {
		admitted.set(keyOf(row), { row, dagVerified });
		if (isGenesis) genesisSeen = true;
		return { status: 'verified', dagVerified, isGenesis };
	};

	const finishInvalid = (row: MessageLike, reason: string): GateVerdict => {
		invalid.set(keyOf(row), reason);
		return { status: 'invalid', reason };
	};

	const parkPending = (row: MessageLike, refs: Record<string, string>, missing: RevisionRef[]): GateVerdict => {
		const key = keyOf(row);
		pending.set(key, { row, refs, seq: seq++ });
		for (const m of missing) {
			const mk = revisionKey(m.messageId, m.signHash);
			if (!blockedOn.has(mk)) blockedOn.set(mk, new Set());
			blockedOn.get(mk)!.add(key);
		}
		// Bounded queue: an attacker can reference revisions that will never
		// exist; unbounded parking would let them grow memory forever.
		if (pending.size > maxPending) {
			let oldestKey: string | null = null;
			let oldestSeq = Infinity;
			for (const [k, e] of pending) if (e.seq < oldestSeq) { oldestSeq = e.seq; oldestKey = k; }
			if (oldestKey && oldestKey !== key) pending.delete(oldestKey);
		}
		return { status: 'waiting', missing };
	};

	/** DAG step for a row whose signature has already been checked. */
	const admitRefs = (row: MessageLike, refs: Record<string, string>): GateVerdict => {
		const verdict = validateRefs(
			{ messageId: row.message_id, signHash: row.sign_hash ?? '' },
			refs,
			{ hasRevision: (k) => admitted.has(k), genesisSeen },
		);
		if (verdict.status === 'violation') return finishInvalid(row, verdict.reason);
		if (verdict.status === 'waiting') return parkPending(row, refs, verdict.missing);
		return finishVerified(row, true, verdict.isGenesis);
	};

	/** Re-tries pending rows whose last missing dependency just landed. */
	const drainUnblocked = (landedKey: string) => {
		const blocked = blockedOn.get(landedKey);
		if (!blocked) return;
		blockedOn.delete(landedKey);
		for (const k of blocked) {
			const entry = pending.get(k);
			if (!entry) continue;
			pending.delete(k);
			const verdict = admitRefs(entry.row, entry.refs);
			if (verdict.status === 'verified') drainUnblocked(k);
		}
	};

	const admit = async (row: MessageLike): Promise<GateVerdict> => {
		const key = keyOf(row);
		const prior = admitted.get(key);
		if (prior) return { status: 'verified', dagVerified: prior.dagVerified, isGenesis: false };

		const signPkey = await deps.resolveSignPkey(row.sender_hash);
		if (!signPkey) {
			// The author's card is itself a replicated row that may simply not
			// have arrived. Park the message; onCardVerified re-admits it.
			const parked = awaitingCard.get(row.sender_hash) ?? new Map<string, MessageLike>();
			parked.set(key, row);
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
		isAdmitted: (messageId: string, signHash: string) => admitted.has(revisionKey(messageId, signHash)),
		getInvalidReason: (messageId: string, signHash: string) => invalid.get(revisionKey(messageId, signHash)) ?? null,
		stats: () => ({ admitted: admitted.size, pending: pending.size, invalid: invalid.size, genesisSeen }),
	};
}
