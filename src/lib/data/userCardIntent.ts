import { getUserCardsCollection } from './collections';
import { readAcceptedBase } from './acceptedSnapshot';
import { enqueueIntent, intentsOf } from './intents';
import { signAndDispatchIntent } from './intentRecovery';
import { DurabilityError, type DeliveryHandle } from './ingest';
import { pendingCardWrites, readCardClock, writeCardClock, withAccountLock, storedWriteState } from './outbox';
import { settled, isLiveNow } from './shapeLink';
import { assertNever } from './storedRead';
import type { ReadyRowIntent } from './intentRecovery';
import type { UserCardRow } from './types';
import { verifyReplicatedRow } from './rowVerification';
import { nextOwnerTimestamp } from './time';

export interface UserCardFields {
	user_hash: string;
	name?: string | null;
	sign_pkey: string;
	contact_pkey: string;
	contact_cert: string;
	crypt_pkey: string;
	crypt_cert: string;
}

type CardMutation = { modified?: { owner_timestamp?: unknown }; changes?: { owner_timestamp?: unknown } };

const timestampOf = (value: unknown): number | null => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : null;
};

export const BOOTSTRAP_CARD_PURPOSE = 'bootstrap-prerequisite' as const;

export type CardBlockReason =
	| 'accepted_locked'
	| 'accepted_corrupt'
	| 'accepted_unavailable'
	/** A card intent or outbox record of this account cannot be read. */
	| 'pending_unreadable'
	/** A bootstrap card's stored write cannot be read or is not this account's. */
	| 'bootstrap_unconfirmed'
	| 'clock_unreadable'
	/** The shape is not live: neither the card nor its absence is proven. */
	| 'shape_unavailable'
	/** The live shape has no card and nothing else proves one. */
	| 'card_unproven'
	/** The live shape has a card for this account that does not verify: neither a card nor its absence. */
	| 'card_unverified';

const BLOCK_MESSAGES: Record<CardBlockReason, string> = {
	accepted_locked: 'the locally accepted card cannot be read while the account is locked',
	accepted_corrupt: 'the locally accepted card is damaged or not this account\'s',
	accepted_unavailable: 'the locally accepted card cannot be read',
	pending_unreadable: 'a pending change to your profile card cannot be read',
	bootstrap_unconfirmed: 'the stored first publication of your profile card cannot be read',
	clock_unreadable: 'the card timestamp record cannot be read',
	shape_unavailable: 'the server\'s copy of your profile card cannot be checked right now',
	card_unproven: 'the server has no profile card for this account',
	card_unverified: 'the server\'s copy of your profile card does not verify',
};

export class CardAuthoringBlockedError extends Error {
	constructor(readonly reason: CardBlockReason) {
		super(`Your profile card cannot be published now (${BLOCK_MESSAGES[reason]}) — nothing new is written until it can be.`);
		this.name = 'CardAuthoringBlockedError';
	}
}

async function pendingCardTimestamp(userHash: string): Promise<{ highest: number | null; inFlight: boolean }> {
	let highest: number | null = null;
	let inFlight = false;
	const consider = (value: unknown) => {
		const ts = timestampOf(value);
		if (ts !== null && (highest === null || ts > highest)) highest = ts;
	};
	const { entries, issues } = await intentsOf(userHash);
	if (issues.some((issue) => issue.owner === 'current')) throw new CardAuthoringBlockedError('pending_unreadable');
	for (const entry of entries) {
		if (entry.relation !== 'user_cards') continue;
		inFlight = true;
		consider((entry.intent as { row?: { owner_timestamp?: unknown } }).row?.owner_timestamp);
	}
	let outboxWrites: Awaited<ReturnType<typeof pendingCardWrites>>;
	try {
		outboxWrites = await pendingCardWrites(userHash);
	} catch {
		throw new CardAuthoringBlockedError('pending_unreadable');
	}
	for (const entry of outboxWrites) {
		if (entry.status !== 'quarantined') inFlight = true;
		for (const m of entry.mutations as CardMutation[]) consider((m.modified ?? m.changes)?.owner_timestamp);
	}
	return { highest, inFlight };
}

export function withCardLock<T>(userHash: string, fn: () => Promise<T>): Promise<T> {
	return withAccountLock(`user_cards:${userHash}`, fn);
}

type AuthoringDecision = Extract<CardDecision, { kind: 'author-bootstrap' | 'author-update' }>;

export async function storeCardIntentUnderLock(
	card: UserCardFields,
	decision: AuthoringDecision,
): Promise<{ intentId: string; readyRow: ReadyRowIntent }> {
	const userHash = card.user_hash;
	const bootstrap = decision.kind === 'author-bootstrap';
	await writeCardClock(userHash, decision.ownerTimestamp);
	const readyRow = {
		kind: 'ready-row' as const,
		relation: 'user_cards',
		mutationType: bootstrap ? 'insert' : 'update',
		...(bootstrap ? { purpose: BOOTSTRAP_CARD_PURPOSE } : {}),
		row: {
			user_hash: userHash,
			name: card.name || 'User',
			sign_pkey: card.sign_pkey,
			contact_pkey: card.contact_pkey,
			contact_cert: card.contact_cert,
			crypt_pkey: card.crypt_pkey,
			crypt_cert: card.crypt_cert,
			owner_timestamp: decision.ownerTimestamp,
		},
	};
	const intentId = await enqueueIntent(readyRow, userHash, 'user_cards');
	if (intentId === null) throw new DurabilityError();
	return { intentId, readyRow };
}

export async function storeUserCardIntentUnderLock(card: UserCardFields): Promise<{ intentId: string; readyRow: ReadyRowIntent }> {
	const decision = await decideCardConstruction(card.user_hash, 'update');
	if (decision.kind === 'blocked') throw new CardAuthoringBlockedError(decision.reason);
	if (decision.kind !== 'author-update') throw new Error(`an ordinary card update cannot be decided as ${decision.kind}`);
	return storeCardIntentUnderLock(card, decision);
}

export function storeUserCardIntent(card: UserCardFields): Promise<{ intentId: string; readyRow: ReadyRowIntent }> {
	return withCardLock(card.user_hash, () => storeUserCardIntentUnderLock(card));
}

export async function publishUserCard(card: UserCardFields, signSkey: Uint8Array): Promise<DeliveryHandle> {
	const { intentId, readyRow } = await storeUserCardIntent(card);
	return signAndDispatchIntent(intentId, readyRow, signSkey);
}

export type PendingBootstrapCard =
	| { kind: 'intent'; intentId: string; intent: ReadyRowIntent }
	/** Stored in the outbox, not yet accepted by the server. */
	| { kind: 'stored'; intentId: string; outboxId: string };

export class BootstrapCardRejectedError extends Error {
	constructor(detail: string) {
		super(`Your profile card was refused (${detail}) — this account cannot be signed in on this device until it is published.`);
		this.name = 'BootstrapCardRejectedError';
	}
}

export type CardConstructionMode = 'register' | 'import' | 'sign-in' | 'update';

export type CardDecision =
	| { kind: 'proven' }
	/** A stored bootstrap card is unaccepted: that exact operation, not a new one. */
	| { kind: 'reuse-bootstrap'; operation: PendingBootstrapCard }
	| { kind: 'author-bootstrap'; ownerTimestamp: number }
	| { kind: 'author-update'; ownerTimestamp: number }
	/** Every stored bootstrap card was refused. */
	| { kind: 'rejected'; reason: string }
	| { kind: 'blocked'; reason: CardBlockReason };

const blocked = (reason: CardBlockReason) => ({ kind: 'blocked', reason }) as const;

type BootstrapOperations =
	| { kind: 'read'; accepted: boolean; pending: PendingBootstrapCard | null; rejected: string | null }
	| { kind: 'blocked'; reason: CardBlockReason };

async function readBootstrapOperations(userHash: string): Promise<BootstrapOperations> {
	let scan: Awaited<ReturnType<typeof intentsOf>>;
	try {
		scan = await intentsOf(userHash, { includeResolved: true });
	} catch {
		return blocked('pending_unreadable');
	}
	let pending: PendingBootstrapCard | null = null;
	let rejected: string | null = null;
	let unconfirmed = false;
	for (const entry of scan.entries) {
		if (entry.relation !== 'user_cards' || (entry.intent as { purpose?: unknown }).purpose !== BOOTSTRAP_CARD_PURPOSE) continue;
		const intent = entry.intent as ReadyRowIntent & { resolved?: boolean; ref?: string | null };
		if (!intent.resolved) {
			pending = { kind: 'intent', intentId: entry.id, intent };
			continue;
		}
		const state = intent.ref ? await storedWriteState(intent.ref, userHash) : { kind: 'unconfirmed' as const };
		if (state.kind === 'accepted') return { kind: 'read', accepted: true, pending: null, rejected: null };
		if (state.kind === 'unconfirmed') unconfirmed = true;
		else if (state.kind === 'rejected') rejected = state.reason;
		else pending = { kind: 'stored', intentId: entry.id, outboxId: intent.ref! };
	}
	if (scan.issues.some((issue) => issue.owner === 'current')) return blocked('pending_unreadable');
	if (unconfirmed) return blocked('bootstrap_unconfirmed');
	return { kind: 'read', accepted: false, pending, rejected };
}

async function readPendingCardWrites(userHash: string): Promise<Awaited<ReturnType<typeof pendingCardTimestamp>> | ReturnType<typeof blocked>> {
	try {
		return await pendingCardTimestamp(userHash);
	} catch {
		return blocked('pending_unreadable');
	}
}

async function nextCardTimestamp(userHash: string, known: number): Promise<number | ReturnType<typeof blocked>> {
	let clock: number;
	try {
		clock = await readCardClock(userHash);
	} catch {
		return blocked('clock_unreadable');
	}
	return nextOwnerTimestamp(Math.max(clock, known));
}

type ShapeCard = { kind: 'card'; row: UserCardRow } | { kind: 'none' } | { kind: 'unverified' };
async function shapeCardOf(row: UserCardRow | undefined): Promise<ShapeCard> {
	if (!row) return { kind: 'none' };
	const verification = await verifyReplicatedRow('user_cards', row as unknown as Record<string, unknown>, async () => null);
	return verification.status === 'verified' ? { kind: 'card', row } : { kind: 'unverified' };
}

export async function decideCardConstruction(userHash: string, mode: CardConstructionMode): Promise<CardDecision> {
	const accepted = await readAcceptedBase('user_cards', userHash, userHash);
	switch (accepted.kind) {
		case 'locked': return blocked('accepted_locked');
		case 'corrupt': return blocked('accepted_corrupt');
		case 'unavailable': return blocked('accepted_unavailable');
		case 'present':
		case 'missing': break;
		default: return assertNever(accepted);
	}
	const cards = getUserCardsCollection();

	if (mode === 'update') {
		let shapeCard = await shapeCardOf(isLiveNow(cards) ? cards.get(userHash) as UserCardRow | undefined : undefined);
		const pending = await readPendingCardWrites(userHash);
		if ('kind' in pending) return pending;
		if (accepted.kind === 'missing' && !pending.inFlight && shapeCard.kind !== 'card') {
			const shape = await settled(cards as unknown as Parameters<typeof settled>[0]);
			if (shape.state === 'live') shapeCard = await shapeCardOf(cards.get(userHash) as UserCardRow | undefined);
			if (shapeCard.kind !== 'card') {
				const ops = await readBootstrapOperations(userHash);
				if (ops.kind === 'blocked') return ops;
				if (!ops.accepted && !ops.pending) {
					if (shapeCard.kind === 'unverified') return blocked('card_unverified');
					return blocked(shape.state === 'live' ? 'card_unproven' : 'shape_unavailable');
				}
			}
		}
		const known = Math.max(
			timestampOf(accepted.kind === 'present' ? accepted.row.owner_timestamp : null) ?? 0,
			timestampOf(shapeCard.kind === 'card' ? shapeCard.row.owner_timestamp : null) ?? 0,
			pending.highest ?? 0,
		);
		const ownerTimestamp = await nextCardTimestamp(userHash, known);
		return typeof ownerTimestamp === 'number' ? { kind: 'author-update', ownerTimestamp } : ownerTimestamp;
	}

	if (accepted.kind === 'present') return { kind: 'proven' };
	const shape = mode === 'register' ? null : await settled(cards as unknown as Parameters<typeof settled>[0]);
	const live = shape?.state === 'live';
	const shapeCard = live ? await shapeCardOf(cards.get(userHash) as UserCardRow | undefined) : { kind: 'none' as const };
	if (shapeCard.kind === 'card') return { kind: 'proven' };

	const ops = await readBootstrapOperations(userHash);
	if (ops.kind === 'blocked') return ops;
	if (ops.accepted) return { kind: 'proven' };
	if (ops.pending) return { kind: 'reuse-bootstrap', operation: ops.pending };
	if (ops.rejected !== null) return { kind: 'rejected', reason: ops.rejected };

	if (shapeCard.kind === 'unverified') return blocked('card_unverified');
	if (mode === 'sign-in') return blocked(live ? 'card_unproven' : 'shape_unavailable');
	if (mode === 'import' && !live) return blocked('shape_unavailable');
	const pending = await readPendingCardWrites(userHash);
	if ('kind' in pending) return pending;
	const ownerTimestamp = await nextCardTimestamp(userHash, pending.highest ?? 0);
	return typeof ownerTimestamp === 'number' ? { kind: 'author-bootstrap', ownerTimestamp } : ownerTimestamp;
}
