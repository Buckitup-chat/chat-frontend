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
import { enqueue, recordFailure, ensureDrainLoop, stopDrainLoop, isLeader, awaitEntryOutcome, type EntryOutcome } from './outbox';
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

	constructor(
		message: string,
		opts: {
			permanent?: boolean;
			uniqueConflictOnly?: boolean;
			conflictIndexes?: number[];
			status?: number | null;
			results?: IngestRowResult[] | null;
		} = {}
	) {
		super(message);
		this.name = 'IngestError';
		this.permanent = opts.permanent ?? false;
		this.uniqueConflictOnly = opts.uniqueConflictOnly ?? false;
		this.conflictIndexes = opts.conflictIndexes ?? [];
		this.status = opts.status ?? null;
		this.results = opts.results ?? null;
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
		throw new IngestError(`ingest network error: ${e}`, { permanent: false });
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
		ensureDrainLoop(owner, (queued) => sendMutationsWithRetry(queued, signSkey, { retries: 1 }),
			{ reconcile: reconcileAccepted },
		);
		return {
			outboxId,
			phase: 'queued',
			acceptance: outboxId
				? awaitEntryOutcome(outboxId, owner)
				: Promise.resolve({ kind: 'rejected', error: 'not durably queued' } as const),
		};
	}

	let result: SendResult;
	try {
		result = await dispatchMutations(mutations, (m) => sendMutationsWithRetry(m, signSkey, opts), outboxId, {
			recordAcceptedSnapshot: opts.recordAcceptedSnapshot,
		});
	} catch (e) {
		if (e instanceof AlreadyDispatchingError) {
			ensureDrainLoop(owner, (queued) => sendMutationsWithRetry(queued, signSkey, { retries: 1 }),
				{ reconcile: reconcileAccepted },
			);
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
		ensureDrainLoop(owner, (queued) => sendMutationsWithRetry(queued, signSkey, { retries: 1 }),
			{ reconcile: reconcileAccepted },
		);
		throw e;
	}
	return {
		outboxId,
		phase: 'accepted',
		result,
		acceptance: outboxId ? awaitEntryOutcome(outboxId, owner) : Promise.resolve({ kind: 'accepted' }),
	};
}

/**
 * Replay writes that never got a server confirmation — after login (keys just
 * became available) and on reconnect. The mutations were signed when created,
 * so they replay verbatim; only the auth challenge needs the live key.
 */
export function drainPendingWrites(userHash: string, signSkey: Uint8Array): void {
	// The loop owns pacing from here: it drains now and keeps its own timer
	// until the queue empties, so a 503 with no connectivity change cannot
	// strand the queue until the next login (ADR §5). `reconcile` runs the
	ensureDrainLoop(userHash, (mutations) => sendMutationsWithRetry(mutations, signSkey, { retries: 1 }),
		// login/'online' is a fresh signal: backoffs computed before it no
		// longer describe the world — everything pending becomes due now
		{ resetSchedules: true, reconcile: reconcileAccepted },
	);
}

export { stopDrainLoop };
