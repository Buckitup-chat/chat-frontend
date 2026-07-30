// Transactional mutation transport: POST mutations to /ingest_each and
// classify per-row outcomes. Replaces the table-scanning sendChanges push:
// each logical write is sent as its own transaction, a bad row fails only
// its own transaction, and successful rows return txids that TanStack DB
// collections await to reconcile optimistic state.
import { api } from '@/api/client';
import type { IngestRowResult } from './types';

export class IngestError extends Error {
	/** true when retrying can never succeed (server-side validation) */
	permanent: boolean;
	status: number | null;
	results: IngestRowResult[] | null;

	constructor(
		message: string,
		opts: { permanent?: boolean; status?: number | null; results?: IngestRowResult[] | null } = {}
	) {
		super(message);
		this.name = 'IngestError';
		this.permanent = opts.permanent ?? false;
		this.status = opts.status ?? null;
		this.results = opts.results ?? null;
	}
}

// "has already been taken" means the row is on the server — success for our purposes.
const isAlreadyExists = (r: IngestRowResult): boolean => {
	if (r.status !== 'error' || r.error !== 'validation_failed') return false;
	return Object.values(r.details || {}).some(
		(v) => Array.isArray(v) && v.some((msg) => /has already been taken/i.test(msg))
	);
};

export interface SendResult {
	txids: number[];
	results: IngestRowResult[];
}

/**
 * Send one logical transaction of mutations. Throws IngestError:
 * permanent=true → drop the write (rollback optimistic state, surface to UI),
 * permanent=false → transient, caller may retry.
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

	const results = body?.results;
	if (!Array.isArray(results)) {
		throw new IngestError(`ingest HTTP ${resp.status}: no per-row results`, {
			permanent: false,
			status: resp.status,
		});
	}

	const failed = results.filter((r) => r.status !== 'ok' && !isAlreadyExists(r));
	if (failed.length > 0) {
		const permanent = failed.every((r) => r.error === 'validation_failed');
		throw new IngestError(
			`ingest rejected ${failed.length}/${results.length} rows: ${JSON.stringify(failed[0]?.details || failed[0]?.error)}`,
			{ permanent, status: resp.status, results }
		);
	}

	return {
		txids: results.filter((r) => typeof r.txid === 'number').map((r) => r.txid as number),
		results,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** sendMutations + exponential backoff for transient failures. */
export async function sendMutationsWithRetry(
	mutations: unknown[],
	signSkey: Uint8Array,
	opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<SendResult> {
	const { retries = 4, baseDelayMs = 1000, maxDelayMs = 30000 } = opts;
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await sendMutations(mutations, signSkey);
		} catch (e) {
			lastError = e;
			if (e instanceof IngestError && e.permanent) throw e;
			if (attempt === retries) break;
			const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
			await sleep(delay + Math.random() * delay * 0.25);
		}
	}
	throw lastError;
}
