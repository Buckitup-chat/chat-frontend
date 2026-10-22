// HTTP transport to a BuckitUp server's /electric/v1 API: challenges and key
// proofs, row writes, device identity, read sessions and one-shot shape
// reads. The wire format is chat/docs/pq/external_client.md.
//
// No policy lives here — what to retry, when to wait for approval, which
// identity signs — only the requests and what their answers mean. The server
// is a parameter, not a build constant, so one process can talk to several.
import { proveChallenge } from './challengeProof.js';
import type { IngestRowResult } from './types.js';

/** ML-DSA-87 over a message, under the identity's sign_skey. */
export type Signer = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface Challenge {
	challenge_id: string;
	challenge: string;
	expires_in?: number;
}

export interface DeviceIdentity {
	device_id: string;
	admin: { user_hash: string; sign_pkey: string } | null;
	sync_bot: { user_hash: string; sign_pkey: string } | null;
}

/** A row write: a TanStack DB mutation as /ingest takes it. */
export type Mutation = Record<string, unknown>;

export interface IngestEachOutcome {
	/** 200 all written, 403 every failure is the access gate, 422 otherwise. */
	status: number;
	results: IngestRowResult[];
}

/** Why the server refuses a write or a read session to an identity the access mode does not admit. */
export const NOT_IN_TRUST_CHAIN = 'not_in_trust_chain';

export type ReadSessionOutcome =
	| { kind: 'opened'; token: string; shape: string; expiresAt: number }
	/** The server has no user_cards row for this identity: write the card, then open again. */
	| { kind: 'unknown_user' }
	/** No vouch chain from the owner for device.<id>.storage.read.<shape>. */
	| { kind: 'not_in_trust_chain' }
	/** Any other refusal (bad challenge or signature, unknown shape). */
	| { kind: 'refused'; status: number; error: string | null };

/** The request got no answer, or an answer that is not the API's. */
export class TransportError extends Error {
	readonly status: number | null;
	/** No answer at all: fetch failed, timed out or was aborted. */
	readonly network: boolean;

	constructor(message: string, opts: { status?: number | null; network?: boolean } = {}) {
		super(message);
		this.name = 'TransportError';
		this.status = opts.status ?? null;
		this.network = opts.network ?? false;
	}
}

export interface TransportOptions {
	/**
	 * The /electric/v1 base: absolute, or a path on the page's origin ("/api"
	 * behind a dev proxy). Requests go to base + path as given — a browser
	 * resolves a relative one; outside a browser pass an absolute base.
	 */
	baseUrl: string;
	/** Defaults to the global fetch, looked up on each call. */
	fetch?: typeof fetch;
	/** Per-request timeout unless a call passes its own signal. */
	timeoutMs?: number;
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface Transport {
	/** Absolute URL of a path under the base, for clients that need one (Electric's ShapeStream). */
	url(path: string): string;
	challenge(opts?: RequestOptions): Promise<Challenge>;
	/** A fresh challenge, signed: the `auth` object a write carries. */
	prove(sign: Signer, opts?: RequestOptions): Promise<{ challenge_id: string; signature: string }>;
	/** POST /ingest_each, answered as it came: callers that classify failures themselves read the body. */
	ingestEachResponse(mutations: Mutation[], sign: Signer, opts?: RequestOptions): Promise<Response>;
	/** POST /ingest_each with the per-row results checked against the request. */
	ingestEach(mutations: Mutation[], sign: Signer, opts?: RequestOptions): Promise<IngestEachOutcome>;
	deviceIdentity(opts?: RequestOptions): Promise<DeviceIdentity>;
	openReadSession(userHash: string, shape: string, sign: Signer, opts?: RequestOptions): Promise<ReadSessionOutcome>;
	/** GET a shape's current rows once, with a bearer token when the caller has one. */
	readShapeOnce<T>(table: string, where: string, opts?: RequestOptions & { authorization?: string }): Promise<ShapeReadResponse<T>>;
}

export type ShapeReadResponse<T> =
	| { ok: true; rows: T[] }
	/** Access mode trust: open a read session for `shape` and read again. */
	| { ok: false; readSessionRequired: string }
	| { ok: false; status: number };

const DEFAULT_TIMEOUT_MS = 30_000;

const isNoAnswer = (e: unknown): boolean =>
	e instanceof TypeError || (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';

/**
 * A where clause nobody is subscribed to. Shapes are cached per (table,
 * where), and one without a live subscriber does not advance its log: a plain
 * re-read can miss rows committed seconds earlier, while a fresh where gets a
 * fresh snapshot. The literal stays under 2^31 — the server's where parser
 * refuses a wider integer with HTTP 500 — and one value is used on both sides,
 * so the predicate is true for every row.
 */
let probe = 0;
export const freshWhere = (where: string): string => {
	const salt = Math.floor(Math.random() * 1e6) * 1000 + (++probe % 1000);
	return `${where} AND ${salt}=${salt}`;
};

export function createTransport(options: TransportOptions): Transport {
	const base = options.baseUrl.replace(/\/+$/, '');
	const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

	const url = (path: string): string => {
		const u = `${base}${path}`;
		if (/^https?:\/\//.test(u)) return u;
		const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
		return `${origin}${u}`;
	};

	const send = async (path: string, init: NonNullable<Parameters<typeof fetch>[1]>, opts: RequestOptions = {}, target = `${base}${path}`): Promise<Response> => {
		const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			return await doFetch(target, { ...init, signal });
		} catch (e) {
			if (isNoAnswer(e)) throw new TransportError(`${path}: no answer (${(e as Error)?.message ?? e})`, { network: true });
			throw e;
		}
	};

	const json = async <T>(resp: Response, path: string): Promise<T> => {
		try {
			return (await resp.json()) as T;
		} catch {
			throw new TransportError(`${path}: HTTP ${resp.status} without a JSON body`, { status: resp.status });
		}
	};

	const challenge = async (opts?: RequestOptions): Promise<Challenge> => {
		const resp = await send('/challenge', { headers: { accept: 'application/json' } }, opts);
		if (!resp.ok) throw new TransportError(`challenge: HTTP ${resp.status}`, { status: resp.status });
		return json<Challenge>(resp, '/challenge');
	};

	const prove = async (sign: Signer, opts?: RequestOptions) => {
		const { challenge_id, challenge: text } = await challenge(opts);
		return { challenge_id, signature: await proveChallenge(text, sign) };
	};

	const ingestEachResponse = async (mutations: Mutation[], sign: Signer, opts?: RequestOptions): Promise<Response> => {
		const auth = await prove(sign, opts);
		return send('/ingest_each', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ auth, mutations }),
		}, opts);
	};

	return {
		url,
		challenge,
		prove,
		ingestEachResponse,

		async ingestEach(mutations, sign, opts) {
			const resp = await ingestEachResponse(mutations, sign, opts);
			const body = await json<{ results?: unknown }>(resp, '/ingest_each');
			return { status: resp.status, results: checkResults(body.results, mutations.length, resp.status) };
		},

		async deviceIdentity(opts) {
			const resp = await send('/device_identity', { headers: { accept: 'application/json' } }, opts);
			if (!resp.ok) throw new TransportError(`device_identity: HTTP ${resp.status}`, { status: resp.status });
			return json<DeviceIdentity>(resp, '/device_identity');
		},

		async openReadSession(userHash, shape, sign, opts) {
			const { challenge_id, signature } = await prove(sign, opts);
			const resp = await send('/read_session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_hash: userHash, shape, challenge_id, signature }),
			}, opts);
			if (resp.ok) {
				const body = await json<{ token: string; shape: string; expires_in: number }>(resp, '/read_session');
				return { kind: 'opened', token: body.token, shape: body.shape, expiresAt: Date.now() + body.expires_in * 1000 };
			}
			if (resp.status >= 500) throw new TransportError(`read_session for ${shape}: HTTP ${resp.status}`, { status: resp.status });
			const error = ((await resp.json().catch(() => null)) as { error?: string } | null)?.error ?? null;
			if (resp.status === 401 && error === 'unknown_user') return { kind: 'unknown_user' };
			if (resp.status === 403 && error === NOT_IN_TRUST_CHAIN) return { kind: 'not_in_trust_chain' };
			return { kind: 'refused', status: resp.status, error };
		},

		async readShapeOnce<T>(table: string, where: string, opts: RequestOptions & { authorization?: string } = {}) {
			const path = `/shapes?table=${table}&where=${encodeURIComponent(freshWhere(where))}&offset=-1`;
			const resp = await send('/shapes', {
				headers: opts.authorization ? { Authorization: opts.authorization } : undefined,
			}, opts, url(path));
			if (resp.status === 401) {
				const body = (await resp.json().catch(() => null)) as { error?: string; shape?: string } | null;
				if (body?.error === 'read_session_required' && body.shape) return { ok: false, readSessionRequired: body.shape };
			}
			if (!resp.ok) return { ok: false, status: resp.status };
			const log = await json<Array<{ value?: T }>>(resp, '/shapes');
			return { ok: true, rows: log.map((r) => r.value).filter((v): v is T => v !== null && v !== undefined) };
		},
	};
}

/**
 * The per-row results of /ingest_each, checked against the request: one
 * result per mutation, each index once, a known status. Anything else is a
 * server answer the client cannot act on.
 */
export function checkResults(results: unknown, mutationCount: number, status: number): IngestRowResult[] {
	if (!Array.isArray(results)) throw new TransportError(`ingest HTTP ${status}: no per-row results`, { status });
	if (results.length !== mutationCount) {
		throw new TransportError(`ingest: expected ${mutationCount} results, got ${results.length}`, { status });
	}
	const seen = new Set<number>();
	for (const r of results) {
		const index = (r as { index?: unknown } | null)?.index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= mutationCount) {
			throw new TransportError(`ingest: malformed result index ${JSON.stringify(index)}`, { status });
		}
		if (seen.has(index)) throw new TransportError(`ingest: duplicate result index ${index}`, { status });
		seen.add(index);
		const rowStatus = (r as { status?: unknown } | null)?.status;
		if (rowStatus !== 'ok' && rowStatus !== 'error' && rowStatus !== 'exists') {
			throw new TransportError(`ingest: unknown result status ${JSON.stringify(rowStatus)} at index ${index}`, { status });
		}
	}
	return results as IngestRowResult[];
}
