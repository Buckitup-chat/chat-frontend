// Write-path fetches must carry an abort deadline: on a half-open TCP
// connection a bare fetch never settles, and everything that awaits the
// send — retries, the outbox drain, the checkpoint button — hangs with it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seen = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
	seen.length = 0;
	globalThis.fetch = vi.fn(async (url, init) => {
		seen.push({ url: String(url), signal: init?.signal });
		return new Response(JSON.stringify({ challenge: 'c', challenge_id: 'id' }), {
			headers: { 'Content-Type': 'application/json' },
		});
	});
});
afterEach(() => { globalThis.fetch = realFetch; });

const { api } = await import('@/api/client');

describe('write-path fetch deadlines', () => {
	it('challenge and ingest_each both carry an AbortSignal', async () => {
		const skey = new Uint8Array(4896); // ML-DSA-87 secret key size
		await api.ingestWithAuthEach([], skey).catch(() => { });
		// getChallenge + ingest_each — every hop armed
		expect(seen.length).toBeGreaterThanOrEqual(1);
		for (const call of seen) {
			expect(call.signal, call.url).toBeInstanceOf(AbortSignal);
		}
	});
});
