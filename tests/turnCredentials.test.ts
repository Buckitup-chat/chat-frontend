// Relay credentials (docs/task-handshake-pq2.md §5a): kept in memory per
// account, asked for again when less than 150 s remain, waited for at most
// 1 s by a session, and "no relay" — never an error — whatever goes wrong;
// a failure is remembered for a minute, or as long as the server says.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const em = { isAuth: true, currentUserHash: 'u_' + 'a'.repeat(128) as string | null, signChallenge: async () => new Uint8Array([1]) };
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));

const {
	_setRelaySourceForTests, clearRelayCredentials, credentialsOf, prefetchRelay, relayIceServers, RENEW_BEFORE_MS, FAILURE_RETRY_MS,
} = await import('@/lib/data/turnCredentials');
type Answer = Awaited<ReturnType<Parameters<typeof _setRelaySourceForTests>[0] & {}>>;

const relay = (tag: string): RTCIceServer[] => [{ urls: [`turn:relay.test:3478?${tag}`], username: tag, credential: 'c' }];

let calls: string[];
let answer: (account: string) => Promise<Answer>;

beforeEach(() => {
	em.isAuth = true;
	em.currentUserHash = 'u_' + 'a'.repeat(128);
	calls = [];
	answer = async () => ({ iceServers: relay('one'), expiresAt: Date.now() + 600_000 });
	_setRelaySourceForTests((account) => {
		calls.push(account);
		return answer(account);
	});
});

afterEach(() => {
	_setRelaySourceForTests(null);
	vi.useRealTimers();
});

describe('relay credentials', () => {
	it('are asked for once when the view opens, and a session takes them from memory', async () => {
		await prefetchRelay();
		await prefetchRelay();
		expect(await relayIceServers()).toEqual(relay('one'));
		expect(calls).toHaveLength(1);
	});

	it('are asked for again when less than 150 s remain', async () => {
		answer = async () => ({ iceServers: relay('short'), expiresAt: Date.now() + RENEW_BEFORE_MS - 1_000 });
		await prefetchRelay();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		answer = async () => ({ iceServers: relay('fresh'), expiresAt: Date.now() + 600_000 });
		expect(await relayIceServers()).toEqual(relay('fresh'));
		expect(calls).toHaveLength(2);
	});

	it('a session waits at most 1 s for a request in flight, then goes on with no relay; the answer is kept for the next', async () => {
		let deliver: (v: { iceServers: RTCIceServer[]; expiresAt: number }) => void = () => {};
		answer = () => new Promise((resolve) => { deliver = resolve; });
		await prefetchRelay();
		const started = Date.now();
		expect(await relayIceServers()).toEqual([]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(950);
		expect(Date.now() - started).toBeLessThan(1_500);
		deliver({ iceServers: relay('late'), expiresAt: Date.now() + 600_000 });
		await vi.waitFor(async () => expect(await relayIceServers(10)).toEqual(relay('late')));
		expect(calls).toHaveLength(1);
	});

	it('a failure is no relay, remembered for a minute: the scanner does not ask again right after the view did', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		answer = async () => { throw new TypeError('Failed to fetch'); };
		await prefetchRelay();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(await relayIceServers()).toEqual([]);
		expect(calls).toHaveLength(1);
		answer = async () => ({ iceServers: relay('back'), expiresAt: Date.now() + 600_000 });
		vi.setSystemTime(Date.now() + FAILURE_RETRY_MS + 1);
		expect(await relayIceServers()).toEqual(relay('back'));
		expect(calls).toHaveLength(2);
	});

	it('a refusal (503, a body that is not credentials) is remembered the same way, and a 429 for as long as it says', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		answer = async () => ({});
		expect(await relayIceServers()).toEqual([]);
		expect(await relayIceServers()).toEqual([]);
		expect(calls).toHaveLength(1);
		vi.setSystemTime(Date.now() + FAILURE_RETRY_MS + 1);
		answer = async () => ({ retryAfterMs: 300_000 });
		expect(await relayIceServers()).toEqual([]);
		vi.setSystemTime(Date.now() + FAILURE_RETRY_MS + 1);
		await prefetchRelay();
		expect(await relayIceServers()).toEqual([]);
		expect(calls).toHaveLength(2);
		vi.setSystemTime(Date.now() + 300_000);
		answer = async () => ({ iceServers: relay('back'), expiresAt: Date.now() + 600_000 });
		expect(await relayIceServers()).toEqual(relay('back'));
		expect(calls).toHaveLength(3);
	});

	it('a failure of one account does not hold back another', async () => {
		answer = async () => ({});
		expect(await relayIceServers()).toEqual([]);
		em.currentUserHash = 'u_' + 'b'.repeat(128);
		answer = async () => ({ iceServers: relay('other'), expiresAt: Date.now() + 600_000 });
		expect(await relayIceServers()).toEqual(relay('other'));
	});

	it('belong to the account that asked: another account asks for its own, and a signed-out one gets none', async () => {
		expect(await relayIceServers()).toEqual(relay('one'));
		em.currentUserHash = 'u_' + 'b'.repeat(128);
		answer = async () => ({ iceServers: relay('other'), expiresAt: Date.now() + 600_000 });
		expect(await relayIceServers()).toEqual(relay('other'));
		expect(calls).toEqual(['u_' + 'a'.repeat(128), 'u_' + 'b'.repeat(128)]);
		em.isAuth = false;
		expect(await relayIceServers()).toEqual([]);
		clearRelayCredentials();
		em.isAuth = true;
		await relayIceServers();
		expect(calls).toHaveLength(3);
	});

	it('are read from the endpoint\'s answer only when it is one: two TURN URIs at most', () => {
		const now = 1_000;
		const body = { username: '1791200000:6f1c', credential: 'x', ttl: 600, uris: ['turn:a:3478?transport=udp', 'turn:a:3478?transport=tcp', 'turn:b:3478', 'stun:a:3478'] };
		expect(credentialsOf(body, now)).toEqual({
			iceServers: [{ urls: ['turn:a:3478?transport=udp', 'turn:a:3478?transport=tcp'], username: '1791200000:6f1c', credential: 'x' }],
			expiresAt: now + 600_000,
		});
		expect(credentialsOf({ ...body, uris: ['stun:a:3478'] }, now)).toBeNull();
		expect(credentialsOf({ ...body, ttl: 0 }, now)).toBeNull();
		expect(credentialsOf({ ...body, credential: undefined }, now)).toBeNull();
		expect(credentialsOf({ error: 'turn_unavailable' }, now)).toBeNull();
		expect(credentialsOf(null, now)).toBeNull();
	});
});

describe('the endpoint client', () => {
	it('reads a 429\'s retry_after, and asks nothing until it has passed', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		_setRelaySourceForTests(null); // the real endpoint client
		const posts: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			if (url.endsWith('/challenge')) return new Response(JSON.stringify({ challenge_id: 'c', challenge: 'x' }));
			posts.push(url);
			return new Response(JSON.stringify({ error: 'rate_limited', retry_after: 120 }), { status: 429 });
		});
		try {
			expect(await relayIceServers()).toEqual([]);
			vi.setSystemTime(Date.now() + 100_000); // past the default minute, inside the server's two
			await prefetchRelay();
			expect(await relayIceServers()).toEqual([]);
			expect(posts).toHaveLength(1);
			vi.setSystemTime(Date.now() + 21_000);
			expect(await relayIceServers()).toEqual([]);
			expect(posts).toHaveLength(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
