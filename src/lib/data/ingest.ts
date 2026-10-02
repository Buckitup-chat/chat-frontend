// Transactional mutation transport: POST mutations to /ingest_each and
// classify per-row outcomes. One logical write = one transaction; successful
// rows return txids that TanStack DB collections await to reconcile
// optimistic state.
//
// Idempotency: a unique-key conflict ("has already been taken") is NOT
// success by itself — the server row may be a different revision, and
// swallowing the conflict silently loses updates. The retry wrapper treats a
// conflict as applied only after proving the server row carries our exact
// signature (see confirm.ts).
import { api } from '@/api/client';
import { mutationAppliedOnServer, type MutationLike } from './confirm';
import { discoverDependencies, reconcileAccepted } from './coordinator';
import { OWNER_FIELD } from './writeContracts';
import { VaultLockedError, AccountMismatchError, resolveSigningKey, type SigningKeySource } from './keyCustody';
import {
	enqueue, stopDrainLoop, awaitEntryOutcome, dependencyBlockFor, wakeAccountSender, releaseNetworkBackoffs,
	awaitDeliveryVerdict, submitEntryToSender, SessionFencedError,
	type DependencyBlockReason, type DeliveryVerdict, type DiscoveryOutcome, type EntryOutcome, type OutboxEntry,
} from './outbox';
import type { IngestRowResult } from './types';

export class IngestError extends Error {
	/** true when retrying can never succeed (server-side validation) */
	permanent: boolean;
	/** true when every failed row is a unique-key conflict — candidate for identity check */
	uniqueConflictOnly: boolean;
	/** indexes of the rows that actually conflicted (never rows the server accepted) */
	conflictIndexes: number[];
	status: number | null;
	results: IngestRowResult[] | null;
	/** true when no answer came back at all: a fact about connectivity, not about this write */
	network: boolean;

	constructor(
		message: string,
		opts: {
			permanent?: boolean;
			uniqueConflictOnly?: boolean;
			conflictIndexes?: number[];
			status?: number | null;
			results?: IngestRowResult[] | null;
			network?: boolean;
		} = {}
	) {
		super(message);
		this.name = 'IngestError';
		this.permanent = opts.permanent ?? false;
		this.uniqueConflictOnly = opts.uniqueConflictOnly ?? false;
		this.conflictIndexes = opts.conflictIndexes ?? [];
		this.status = opts.status ?? null;
		this.results = opts.results ?? null;
		this.network = opts.network ?? false;
	}
}

const isUniqueConflict = (r: IngestRowResult): boolean => {
	if (r.status === 'ok' || r.error !== 'validation_failed') return false;
	return Object.values(r.details || {}).some(
		(v) => Array.isArray(v) && v.some((msg) => /has already been taken/i.test(msg))
	);
};

const isTimestampNotNewer = (r: IngestRowResult): boolean => {
	if (r.status === 'ok' || r.error !== 'validation_failed') return false;
	const field = r.details?.owner_timestamp;
	return Array.isArray(field) && field.some((msg) => /timestamp not newer/i.test(msg));
};

const isExistsConflict = (r: IngestRowResult): boolean => r.status === 'exists';

function validateBatchResults(results: unknown, mutationCount: number, status: number): IngestRowResult[] {
	if (!Array.isArray(results)) {
		throw new IngestError(`ingest HTTP ${status}: no per-row results`, { permanent: false, status });
	}
	if (results.length !== mutationCount) {
		throw new IngestError(
			`ingest: expected ${mutationCount} results, got ${results.length}`,
			{ permanent: false, status }
		);
	}
	const seen = new Set<number>();
	for (const r of results) {
		const index = (r as { index?: unknown } | null)?.index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= mutationCount) {
			throw new IngestError(`ingest: malformed result index ${JSON.stringify(index)}`, { permanent: false, status });
		}
		if (seen.has(index)) {
			throw new IngestError(`ingest: duplicate result index ${index}`, { permanent: false, status });
		}
		seen.add(index);
		const rowStatus = (r as { status?: unknown } | null)?.status;
		if (rowStatus !== 'ok' && rowStatus !== 'error' && rowStatus !== 'exists') {
			throw new IngestError(`ingest: unknown result status ${JSON.stringify(rowStatus)} at index ${index}`, { permanent: false, status });
		}
	}
	return results as IngestRowResult[];
}

export interface SendResult {
	txids: number[];
	results: IngestRowResult[];
}

/**
 * Send one logical transaction of mutations. Throws IngestError:
 * permanent=true → drop the write (rollback optimistic state, surface to UI),
 * permanent=false → transient, caller may retry.
 * uniqueConflictOnly=true → all failures are key conflicts; the retry wrapper
 * may resolve them via the signature identity check.
 */
export async function sendMutations(mutations: unknown[], signSkey: Uint8Array): Promise<SendResult> {
	let resp: Response;
	try {
		resp = await api.ingestWithAuthEach(mutations, signSkey);
	} catch (e) {
		if (e instanceof VaultLockedError || e instanceof AccountMismatchError) throw e;
		// Only a request that got no answer — fetch failed or timed out — is a
		// fact about connectivity; a server that answered with garbage is not.
		const network = e instanceof TypeError || (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
		throw new IngestError(`ingest network error: ${e}`, { permanent: false, network });
	}

	// The server reports per-row outcomes in the body even on 4xx.
	let body: { results?: IngestRowResult[] } | null = null;
	try {
		body = await resp.json();
	} catch {
		/* non-JSON body */
	}

	const results = validateBatchResults(body?.results, mutations.length, resp.status);

	// A PK conflict the server can resolve itself against a registered Shape
	// module comes back as status "exists" (HTTP 200, not "error"), with its
	// own verdict on whether our row IS the stored one: `conflicted: false`
	// is an idempotent retry — already applied by an earlier attempt whose
	// response we never saw — and must be treated as success, not failure.
	// `conflicted: true` is a genuine different-revision conflict and, like
	// the text-matched fallback below, a final verdict worth retrying.
	const isResolvedConflict = (r: IngestRowResult): boolean => r.status === 'exists' && r.conflicted === false;

	const failed = results.filter((r) => r.status !== 'ok' && !isResolvedConflict(r));
	if (failed.length > 0) {
		// A 422 row outcome is the server's final verdict — validation or a
		// business rule (e.g. "cannot react to own message"). Retrying the
		// same signed mutation can never change it; only network-level
		// failures (5xx, 429, no response) are worth retrying.
		const permanent = resp.status === 422;
		const isConflict = (r: IngestRowResult) => isExistsConflict(r) || isUniqueConflict(r) || isTimestampNotNewer(r);
		const uniqueConflictOnly = failed.every(isConflict);
		// Only the rows the server actually rejected need an identity check;
		// rows it reported as ok are already confirmed by this response and
		// must not be made to depend on shape propagation.
		const conflictIndexes = failed.filter(isConflict).map((r) => r.index);
		throw new IngestError(
			`ingest rejected ${failed.length}/${results.length} rows: ${JSON.stringify(failed[0]?.details || failed[0]?.error)}`,
			{ permanent, uniqueConflictOnly, conflictIndexes, status: resp.status, results }
		);
	}

	return {
		txids: results.filter((r) => typeof r.txid === 'number').map((r) => r.txid as number),
		results,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
	retries?: number;
	/**
	 * In-process retries after a request that got no answer at all; defaults
	 * to `retries`. A write already in the outbox keeps at most one: beyond a
	 * lost response its retry belongs to the outbox schedule, and waiting here
	 * would hold the send lock that every other write of the account needs.
	 */
	networkRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Identity check for unique-key conflicts; overridable for tests. */
	confirmApplied?: (mutation: MutationLike, opts?: { attempts?: number; delayMs?: number }) => Promise<boolean>;
}

/**
 * sendMutations + exponential backoff for transient failures.
 *
 * A unique-conflict outcome is resolved through the identity check: if the
 * server already holds exactly our signed rows (e.g. a retry after a network
 * error where the first attempt actually landed), that is success; otherwise
 * it is a permanent conflict surfaced to the caller.
 */
export async function sendMutationsWithRetry(
	mutations: unknown[],
	signSkey: Uint8Array,
	opts: RetryOptions = {}
): Promise<SendResult> {
	const {
		retries = 4,
		baseDelayMs = 1000,
		maxDelayMs = 30000,
		confirmApplied = mutationAppliedOnServer,
	} = opts;
	const networkRetries = opts.networkRetries ?? retries;
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await sendMutations(mutations, signSkey);
		} catch (e) {
			lastError = e;

			if (e instanceof IngestError && e.uniqueConflictOnly) {
				const confirmations = await Promise.all(
					e.conflictIndexes.map((index) => confirmApplied(mutations[index] as MutationLike))
				);
				if (confirmations.every(Boolean)) {
					const txids = (e.results ?? [])
						.filter((r) => typeof r.txid === 'number')
						.map((r) => r.txid as number);
					return { txids, results: e.results ?? [] };
				}
				throw new IngestError('conflicting row already exists on the server with different content', {
					permanent: true,
					uniqueConflictOnly: true,
					conflictIndexes: e.conflictIndexes,
					status: e.status,
					results: e.results,
				});
			}

			if (e instanceof IngestError && e.permanent) throw e;
			if (e instanceof VaultLockedError || e instanceof AccountMismatchError) throw e;
			if (attempt === retries) break;
			if (e instanceof IngestError && e.network && attempt >= networkRetries) break;
			const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
			await sleep(delay + Math.random() * delay * 0.25);
		}
	}
	throw lastError;
}

interface MutationShape {
	type?: string;
	modified?: Record<string, unknown>;
	changes?: Record<string, unknown>;
	syncMetadata?: { relation?: string };
}

// Re-exported so callers can attribute a durable intent (intents.ts, §3.1) to
// its owner before a mutation exists to read syncMetadata.relation from.
export { OWNER_FIELD };

const ownerOf = (mutations: unknown[]): string => {
	const first = mutations[0] as MutationShape | undefined;
	const relation = first?.syncMetadata?.relation;
	if (!relation) return '';
	const row = first?.modified ?? first?.changes;
	const field = OWNER_FIELD[relation];
	const value = field ? row?.[field] : undefined;
	return typeof value === 'string' ? value : '';
};

/** Durable storage refused the write — the mutation was NOT sent. */
export class DurabilityError extends Error {
	constructor() {
		super('This message could not be stored for sending. Nothing was sent — try again.');
		this.name = 'DurabilityError';
	}
}

export interface DeliveryHandle {
	outboxId: string | null;
	phase: 'accepted' | 'queued';
	result?: SendResult;
	acceptance: Promise<EntryOutcome>;
	held?: { reason: DependencyBlockReason | 'state_unconfirmed'; message: string };
}

export interface LiveSendOptions {
	onDurable?: (outboxId: string) => void | Promise<void>;
	sourceIntentId?: string;
	excludeFromDependencies?: string[];
	targeted?: boolean;
}

export async function sendMutationsAndAwaitShape(
	mutations: unknown[],
	signSkey: SigningKeySource,
	opts: LiveSendOptions = {}
): Promise<DeliveryHandle> {
	const owner = ownerOf(mutations);
	let discovery: DiscoveryOutcome;
	try {
		discovery = await discoverDependencies(mutations, owner, opts.excludeFromDependencies);
	} catch (e) {
		discovery = { kind: 'blocked', block: dependencyBlockFor(e, { kind: 'discovery', observedKeys: null }) };
	}
	const outboxId = await enqueue(mutations, owner, discovery.kind === 'blocked'
		? { discoveryBlocked: discovery.block, sourceIntentId: opts.sourceIntentId, observeAttempt: true }
		: { dependsOn: discovery.dependsOn, sourceIntentId: opts.sourceIntentId, observeAttempt: true });
	// ADR §11: a write that cannot be stored fails visibly; nothing is sent.
	if (outboxId === null) throw new DurabilityError();
	await opts.onDurable?.(outboxId);

	const submission = await submitEntryToSender(owner, outboxId, replaySend(signSkey), senderHooks, { targeted: opts.targeted });
	const queued = (acceptance: Promise<EntryOutcome> = awaitEntryOutcome(outboxId, owner)): DeliveryHandle => ({
		outboxId,
		phase: 'queued',
		acceptance,
		...(submission.disposition.kind === 'queued' && submission.disposition.held ? { held: submission.disposition.held } : {}),
	});
	if (submission.disposition.kind === 'queued') return queued();
	if (submission.disposition.kind === 'settled') {
		const { outcome } = submission.disposition;
		return outcome.kind === 'accepted'
			? { outboxId, phase: 'accepted', acceptance: awaitEntryOutcome(outboxId, owner) }
			: queued(Promise.resolve(outcome));
	}

	const attempt = await submission.attempt;
	switch (attempt.kind) {
		case 'accepted':
			return { outboxId, phase: 'accepted', result: attempt.result as SendResult, acceptance: awaitEntryOutcome(outboxId, owner) };
		case 'failed':
			throw attempt.error;
		case 'fenced':
			throw new SessionFencedError(`sendMutationsAndAwaitShape: the session changed before outbox entry ${outboxId} was sent`);
		case 'settled-elsewhere':
			return attempt.outcome.kind === 'accepted'
				? { outboxId, phase: 'accepted', acceptance: awaitEntryOutcome(outboxId, owner) }
				: queued(Promise.resolve(attempt.outcome));
		case 'deferred':
			return queued();
		default: {
			const unknown: never = attempt;
			throw new Error(`sendMutationsAndAwaitShape: unknown attempt ${JSON.stringify(unknown)}`);
		}
	}
}

/**
 * How the sender sends an entry: one HTTP request per attempt. A failure is
 * recorded on the entry with its next attempt time, and the outbox schedule
 * is the only retry. A unique-key conflict is still checked against the
 * server's row (our exact signature is success).
 */
const replaySend = (signingKey: SigningKeySource) => async (mutations: unknown[]) =>
	// The key is taken when the request is made: a locked account throws
	// VaultLockedError here, before anything is sent.
	sendMutationsWithRetry(mutations, await resolveSigningKey(signingKey), { retries: 0, networkRetries: 0 });

const senderHooks = { reconcile: (mutations: unknown[], result?: unknown) => reconcileAccepted(mutations, result), rediscover: (entry: OutboxEntry) => rediscoverDependencies(entry) };

function wakeSender(owner: string, signSkey: SigningKeySource, opts: { releaseNetworkBackoffs?: boolean } = {}): void {
	void (async () => {
		if (opts.releaseNetworkBackoffs) await releaseNetworkBackoffs(owner);
		wakeAccountSender(owner, replaySend(signSkey), senderHooks);
	})();
}

export function resumePendingWrites(userHash: string, signSkey: SigningKeySource): void {
	wakeSender(userHash, signSkey, { releaseNetworkBackoffs: true });
}

/**
 * Send one stored write now — the exact stored mutation, never rebuilt — by a
 * targeted run of the account's sender, without draining the rest of the
 * queue: a write whose acceptance something waits on before the session
 * starts (a bootstrap card at sign-in). Its readiness (dependencies, held
 * state, schedule) is the sender's, as for any write. A transient failure is
 * recorded on the entry and reported as `retrying`, as is a write that is not
 * ready now; a rejection quarantines it and is reported as `rejected`. In a
 * tab that does not lead the account's sending, the leader tab sends it and
 * this waits for its verdict.
 */
export async function deliverStoredWrite(outboxId: string, userHash: string, signSkey: SigningKeySource): Promise<DeliveryVerdict> {
	let submission: Awaited<ReturnType<typeof submitEntryToSender>>;
	try {
		submission = await submitEntryToSender(userHash, outboxId, replaySend(signSkey), senderHooks, { targeted: true });
	} catch {
		return awaitDeliveryVerdict(outboxId, userHash); // not readable as this account's entry now: its stored verdict decides
	}
	const { disposition } = submission;
	if (disposition.kind === 'settled') return disposition.outcome;
	if (disposition.kind === 'queued') {
		return disposition.reason === 'not-sender' ? awaitDeliveryVerdict(outboxId, userHash) : { kind: 'retrying' };
	}
	const attempt = await submission.attempt;
	switch (attempt.kind) {
		case 'accepted': return { kind: 'accepted' };
		case 'failed':
			return attempt.error instanceof IngestError && attempt.error.permanent
				? { kind: 'rejected', error: attempt.error.message }
				: { kind: 'retrying' };
		case 'fenced': throw new SessionFencedError(`deliverStoredWrite: the session changed before outbox entry ${outboxId} was sent`);
		case 'settled-elsewhere': return attempt.outcome;
		case 'deferred': return awaitDeliveryVerdict(outboxId, userHash);
		default: {
			const unknown: never = attempt;
			throw new Error(`deliverStoredWrite: unknown attempt ${JSON.stringify(unknown)}`);
		}
	}
}

export const rediscoverDependencies = async (entry: OutboxEntry): Promise<DiscoveryOutcome> => {
	const block = entry.discoveryBlocked;
	if (!block || block.observedKeys === null) {
		return { kind: 'blocked', block: dependencyBlockFor(null, { kind: block?.kind ?? 'discovery', observedKeys: null }) };
	}
	return discoverDependencies(entry.mutations, entry.userHash, [entry.id], {
		observedKeys: block.observedKeys,
		...(block.kind === 'admission' ? { admission: block.admission ?? { scope: '', generation: null } } : { freshnessChecked: true }),
	});
};

/**
 * Replay writes that never got a server confirmation — after login (keys just
 * became available) and on reconnect. The mutations were signed when created,
 * so they replay verbatim; only the auth challenge needs the live key.
 */
export function drainPendingWrites(userHash: string, signSkey: SigningKeySource): void {
	// The loop owns pacing from here: it drains what is due now and keeps its
	// own timer until the queue empties, so a 503 with no connectivity change
	// cannot strand the queue until the next login (ADR §5). Login, a reload,
	// a leader takeover or another tab's wake prove nothing about the server or
	// the connection: every stored retry time stands.
	wakeSender(userHash, signSkey);
}

export { stopDrainLoop };
