import { api } from '@/api/client';
import { mutationAppliedOnServer } from './confirm';
import { dispatchMutations, dependenciesFor } from './coordinator';
import { OWNER_FIELD } from './writeContracts';
import { enqueue, resolveEntry, recordFailure, ensureDrainLoop, stopDrainLoop } from './outbox';
import type { IngestRowResult } from './types';

export class IngestError extends Error {
	permanent: boolean;
	uniqueConflictOnly: boolean;
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
	}
	return results as IngestRowResult[];
}

export interface SendResult {
	txids: number[];
	results: IngestRowResult[];
}

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

	const failed = results.filter((r) => r.status !== 'ok');
	if (failed.length > 0) {
		const permanent = resp.status === 422;
		const uniqueConflictOnly = failed.every(isUniqueConflict);
		const conflictIndexes = failed.filter(isUniqueConflict).map((r) => r.index);
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
	confirmApplied?: (mutation: unknown) => Promise<boolean>;
}

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
					e.conflictIndexes.map((index) => confirmApplied(mutations[index]))
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

export class DurabilityError extends Error {
	constructor() {
		super('This message could not be stored for sending. Nothing was sent — try again.');
		this.name = 'DurabilityError';
	}
}

export async function sendMutationsAndAwaitShape(
	mutations: unknown[],
	signSkey: Uint8Array,
	opts: RetryOptions & { durability?: 'required' | 'best-effort' } = {}
): Promise<SendResult> {
	const owner = ownerOf(mutations);
	const dependsOn = await dependenciesFor(mutations, owner);
	const outboxId = await enqueue(mutations, owner, { dependsOn });

	if (outboxId === null && (opts.durability ?? 'required') === 'required') {
		throw new DurabilityError();
	}

	let result: SendResult;
	try {
		result = await dispatchMutations(mutations, (m) => sendMutationsWithRetry(m, signSkey, opts));
	} catch (e) {
		await recordFailure(outboxId, e);
		ensureDrainLoop(owner, (queued) =>
			dispatchMutations(queued, (m) => sendMutationsWithRetry(m, signSkey, { retries: 1 }))
		);
		throw e;
	}
	await resolveEntry(outboxId);
	return result;
}

export function drainPendingWrites(userHash: string, signSkey: Uint8Array): void {
	ensureDrainLoop(userHash, (mutations) =>
		dispatchMutations(mutations, (m) => sendMutationsWithRetry(m, signSkey, { retries: 1 })),

		{ resetSchedules: true },
	);
}

export { stopDrainLoop };
