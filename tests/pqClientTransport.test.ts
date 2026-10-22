// @buckitup/pq-client/transport against a fake server that keeps the
// contract the real one does (chat/docs/pq/external_client.md): a challenge is
// single use, and a request's key proof must be ML-DSA-87 over the challenge's
// UTF-8 bytes, unpadded base64, under the identity's key.
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { randomBytes } from '@noble/hashes/utils';
import { createTransport, checkResults, freshWhere, TransportError } from '@buckitup/pq-client/transport';

const keys = ml_dsa87.keygen(randomBytes(32));
const sign = (m: Uint8Array) => ml_dsa87.sign(m, keys.secretKey);
const USER = 'u_' + 'a'.repeat(128);

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen { url: string; init: RequestInit | undefined }

/** A server with one identity on it. `answer` decides each request that passed the key proof. */
const fakeServer = (answer: (path: string, body: Record<string, unknown>, init?: RequestInit) => Response) => {
	const challenges = new Map<string, string>();
	const seen: Seen[] = [];
	let n = 0;
	const verifies = (id: unknown, signature: unknown): boolean => {
		const challenge = challenges.get(String(id));
		challenges.delete(String(id)); // single use, whatever the outcome
		if (!challenge || typeof signature !== 'string' || signature.endsWith('=')) return false;
		return ml_dsa87.verify(fromB64(signature), new TextEncoder().encode(challenge), keys.publicKey);
	};
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, init });
		const path = new URL(url, 'http://host').pathname.replace(/^\/api/, '');
		if (path === '/challenge') {
			const id = `c${++n}`;
			const challenge = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
			challenges.set(id, challenge);
			return json(200, { challenge_id: id, challenge, expires_in: 60 });
		}
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
		if (path === '/ingest_each') {
			const auth = body.auth as { challenge_id?: string; signature?: string } | undefined;
			if (!verifies(auth?.challenge_id, auth?.signature)) return json(401, { error: 'invalid_signature' });
		}
		if (path === '/read_session' && !verifies(body.challenge_id, body.signature)) return json(401, { error: 'invalid_signature' });
		return answer(path, body, init);
	}) as typeof fetch;
	return { fetchImpl, seen };
};

describe('@buckitup/pq-client transport', () => {
	it('writes rows with a key proof over a fresh challenge and returns the checked per-row results', async () => {
		const server = fakeServer((path, body) => {
			expect(path).toBe('/ingest_each');
			const mutations = body.mutations as unknown[];
			return json(200, { results: mutations.map((_, index) => ({ index, status: 'ok', txid: 7 })) });
		});
		const t = createTransport({ baseUrl: '/api', fetch: server.fetchImpl });
		const outcome = await t.ingestEach([{ type: 'insert' }, { type: 'insert' }], sign);
		expect(outcome).toEqual({ status: 200, results: [{ index: 0, status: 'ok', txid: 7 }, { index: 1, status: 'ok', txid: 7 }] });
		// Relative base: requests go to base + path as given, as a browser page sends them.
		expect(server.seen.map((s) => s.url)).toEqual(['/api/challenge', '/api/ingest_each']);
	});

	it('a proof the server cannot verify is refused: the fake checks what the real server checks', async () => {
		const server = fakeServer(() => json(200, { results: [] }));
		const t = createTransport({ baseUrl: '/api', fetch: server.fetchImpl });
		const other = ml_dsa87.keygen(randomBytes(32));
		const resp = await t.ingestEachResponse([], (m) => ml_dsa87.sign(m, other.secretKey));
		expect(resp.status).toBe(401);
	});

	it('refuses per-row results that do not answer the request', () => {
		expect(() => checkResults(undefined, 1, 500)).toThrow(TransportError);
		expect(() => checkResults([{ index: 0, status: 'ok' }], 2, 200)).toThrow(/expected 2 results/);
		expect(() => checkResults([{ index: 0, status: 'ok' }, { index: 0, status: 'ok' }], 2, 200)).toThrow(/duplicate/);
		expect(() => checkResults([{ index: 0, status: 'maybe' }], 1, 200)).toThrow(/unknown result status/);
		expect(checkResults([{ index: 0, status: 'exists' }], 1, 200)).toEqual([{ index: 0, status: 'exists' }]);
	});

	it('a request that gets no answer is a network TransportError', async () => {
		const t = createTransport({ baseUrl: 'https://x.example/electric/v1', fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
		const e = await t.challenge().catch((err: unknown) => err);
		expect(e).toBeInstanceOf(TransportError);
		expect((e as TransportError).network).toBe(true);
	});

	it('reads the outcome of a read session request', async () => {
		const answers: Response[] = [
			json(200, { token: 'tok', shape: 'dialog_messages', expires_in: 300 }),
			json(401, { error: 'unknown_user' }),
			json(403, { error: 'not_in_trust_chain', max_depth: 7 }),
			json(400, { error: 'unknown_shape' }),
		];
		const server = fakeServer((path, body) => {
			expect(path).toBe('/read_session');
			expect(body).toMatchObject({ user_hash: USER, shape: 'dialog_messages' });
			return answers.shift()!;
		});
		const t = createTransport({ baseUrl: '/api', fetch: server.fetchImpl });
		const before = Date.now();
		const opened = await t.openReadSession(USER, 'dialog_messages', sign);
		expect(opened).toMatchObject({ kind: 'opened', token: 'tok', shape: 'dialog_messages' });
		expect(opened.kind === 'opened' && opened.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
		expect(await t.openReadSession(USER, 'dialog_messages', sign)).toEqual({ kind: 'unknown_user' });
		expect(await t.openReadSession(USER, 'dialog_messages', sign)).toEqual({ kind: 'not_in_trust_chain' });
		expect(await t.openReadSession(USER, 'dialog_messages', sign)).toEqual({ kind: 'unknown_shape' });
		// A proof by another key: the fake refuses it as the server does.
		const other = ml_dsa87.keygen(randomBytes(32));
		expect(await t.openReadSession(USER, 'dialog_messages', (m) => ml_dsa87.sign(m, other.secretKey))).toEqual({ kind: 'bad_proof' });
	});

	it('reads a shape once under a fresh where, with the caller\'s bearer token, and reports a required session', async () => {
		const answers = [
			json(200, [{ value: { user_hash: USER } }, { headers: { control: 'up-to-date' } }]),
			json(401, { error: 'read_session_required', shape: 'user_storage' }),
		];
		const server = fakeServer(() => answers.shift()!);
		const t = createTransport({ baseUrl: 'https://x.example/electric/v1', fetch: server.fetchImpl });

		expect(await t.readShapeOnce('user_cards', `user_hash = '${USER}'`, { authorization: 'Bearer tok' })).toEqual({ kind: 'rows', rows: [{ user_hash: USER }] });
		const { url, init } = server.seen[0];
		const where = decodeURIComponent(new URL(url).searchParams.get('where')!);
		expect(url.startsWith('https://x.example/electric/v1/shapes?table=user_cards&')).toBe(true);
		expect(where).toMatch(new RegExp(`^user_hash = '${USER}' AND (\\d+)=\\1$`));
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');

		expect(await t.readShapeOnce('user_storage', 'true')).toEqual({ kind: 'read_session_required', shape: 'user_storage' });
	});

	it('a fresh where is new on every call and true for every row', () => {
		const a = freshWhere('x = 1');
		const b = freshWhere('x = 1');
		expect(a).not.toBe(b);
		for (const w of [a, b]) {
			const [, left, right] = w.match(/AND (\d+)=(\d+)$/)!;
			expect(left).toBe(right);
			expect(Number(left)).toBeLessThan(2 ** 31);
		}
	});
});
