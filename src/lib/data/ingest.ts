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
import { dispatchMutations, dependenciesFor, reconcileAccepted, AlreadyDispatchingError } from './coordinator';
import { StaleBaseError } from './staleBase';
import { OWNER_FIELD } from './writeContracts';
import { enqueue, recordFailure, ensureDrainLoop, stopDrainLoop, isLeader, awaitEntryOutcome, hasNetworkBackoffs, type EntryOutcome } from './outbox';
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

/**
 * Send mutations AND wait until the resulting transaction is visible in the
 * collection that later writes read as their base.
 *
 * Use this for every write whose successor derives parent_sign_hash /
 * owner_timestamp / existence from the shape. Without the barrier a caller
 * can sign against a tip the server has already superseded — the HTTP 200
 * only proves the Postgres commit, not shape delivery.
 */
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
}

export async function sendMutationsAndAwaitShape(
	mutations: unknown[],
	signSkey: Uint8Array,
	opts: RetryOptions & {
		durability?: 'required' | 'best-effort';
		onDurable?: (outboxId: string) => void | Promise<void>;
		sourceIntentId?: string;
		excludeFromDependencies?: string[];
		recordAcceptedSnapshot?: boolean;
	} = {}
): Promise<DeliveryHandle> {
	// Durability first: the signed mutations hit IndexedDB before the network,
	// so a reload or crash mid-send replays them on the next login instead of
	// losing them. The entry is removed only after the server confirms.
	const owner = ownerOf(mutations);
	let dependsOn: string[];
	try {
		dependsOn = await dependenciesFor(mutations, owner, opts.excludeFromDependencies);
	} catch (e) {
		if (e instanceof StaleBaseError) throw e;
		dependsOn = [];
	}
	const outboxId = await enqueue(mutations, owner, { dependsOn, sourceIntentId: opts.sourceIntentId });

	// ADR §11: when durable storage is unavailable, a user-visible mutation
	// fails visibly — a best-effort network send that looks identical to
	// success is the one state the interface must never claim. Callers that
	// legitimately run before the vault unlocks opt out per call.
	if (outboxId === null && (opts.durability ?? 'required') === 'required') {
		throw new DurabilityError();
	}
	if (outboxId !== null) await opts.onDurable?.(outboxId);
	if (!isLeader() || dependsOn.length > 0) {
		armDrain(owner, signSkey);
		return {
			outboxId,
			phase: 'queued',
			acceptance: outboxId
				? awaitEntryOutcome(outboxId, owner)
				: Promise.resolve({ kind: 'rejected', error: 'not durably queued' } as const),
		};
	}

	// A write already in the outbox does not wait out a missing connection
	// here: one quick retry covers a lost response, and after that the retry
	// is the outbox's — a longer loop in this call would hold the send lock
	// every other write of the account is waiting for.
	const sendOpts = outboxId !== null ? { ...opts, networkRetries: 1 } : opts;
	let result: SendResult;
	try {
		result = await dispatchMutations(mutations, (m) => sendMutationsWithRetry(m, signSkey, sendOpts), outboxId, {
			recordAcceptedSnapshot: opts.recordAcceptedSnapshot,
		});
	} catch (e) {
		if (e instanceof AlreadyDispatchingError) {
			armDrain(owner, signSkey);
			return {
				outboxId,
				phase: 'queued',
				acceptance: outboxId
					? awaitEntryOutcome(outboxId, owner)
					: Promise.resolve({ kind: 'rejected', error: 'not durably queued' } as const),
			};
		}
		// Permanent rejections die in the outbox too; transient failures stay
		// for the next drain. Either way the caller sees the same error as
		// before the outbox existed.
		await recordFailure(outboxId, e);
		// The drain loop stops itself when the queue empties, so a live-send
		// that fails after that point would leave a durable, retryable entry
		// with nothing scheduled to retry it — waiting on a later login or an
		// 'online' event that may never come. Arming the loop here is what
		// makes "retryable" mean the client will actually try again (ADR §5).
		armDrain(owner, signSkey);
		throw e;
	}
	// The server answered, so the account is reachable: whatever waits in the
	// outbox — queued behind this send, or backing off after a lost
	// connection that no `online` event reported — goes now.
	resumeQueueAfterAnswer(owner, signSkey);
	return {
		outboxId,
		phase: 'accepted',
		result,
		acceptance: outboxId ? awaitEntryOutcome(outboxId, owner) : Promise.resolve({ kind: 'accepted' }),
	};
}

/** How the outbox replays an entry: one quick retry for a server hiccup, none for a missing connection. */
const replaySend = (signSkey: Uint8Array) => (mutations: unknown[]) =>
	sendMutationsWithRetry(mutations, signSkey, { retries: 1, networkRetries: 0 });

function armDrain(owner: string, signSkey: Uint8Array, opts: { resetSchedules?: boolean; releaseNetworkBackoffs?: boolean } = {}): void {
	ensureDrainLoop(owner, replaySend(signSkey), { ...opts, reconcile: reconcileAccepted });
}

function resumeQueueAfterAnswer(owner: string, signSkey: Uint8Array): void {
	if (hasNetworkBackoffs(owner)) armDrain(owner, signSkey, { releaseNetworkBackoffs: true });
}

/**
 * The page came back into view: timers frozen while it was hidden may not
 * have run. Replays what is due and what only waited for a connection;
 * backoffs after a server failure stand — a visible page says nothing about
 * the server.
 */
export function resumePendingWrites(userHash: string, signSkey: Uint8Array): void {
	armDrain(userHash, signSkey, { releaseNetworkBackoffs: true });
}

/**
 * Replay writes that never got a server confirmation — after login (keys just
 * became available) and on reconnect. The mutations were signed when created,
 * so they replay verbatim; only the auth challenge needs the live key.
 */
export function drainPendingWrites(userHash: string, signSkey: Uint8Array): void {
	// The loop owns pacing from here: it drains now and keeps its own timer
	// until the queue empties, so a 503 with no connectivity change cannot
	// strand the queue until the next login (ADR §5).
	// login/'online'/back in view is a fresh signal: backoffs computed before
	// it no longer describe the world — everything pending becomes due now
	armDrain(userHash, signSkey, { resetSchedules: true });
}

export { stopDrainLoop };
