// Relay credentials (docs/task-handshake-pq2.md §5a): kept in memory per
// account, asked for again when less than 150 s remain, waited for at most
// 1 s by a session, and "no relay" — never an error — whatever goes wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const em = { isAuth: true, currentUserHash: 'u_' + 'a'.repeat(128) as string | null, signChallenge: async () => new Uint8Array([1]) };
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));

const {
	_setRelaySourceForTests, clearRelayCredentials, credentialsOf, prefetchRelay, relayIceServers, RENEW_BEFORE_MS,
} = await import('@/lib/data/turnCredentials');

const relay = (tag: string): RTCIceServer[] => [{ urls: [`turn:relay.test:3478?${tag}`], username: tag, credential: 'c' }];

let calls: string[];
let answer: (account: string) => Promise<{ iceServers: RTCIceServer[]; expiresAt: number } | null>;

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

	it('a failure is no relay, and the next view asks again', async () => {
		answer = async () => { throw new TypeError('Failed to fetch'); };
		expect(await relayIceServers()).toEqual([]);
		answer = async () => null; // 503 turn_unavailable, 429, a body that is not credentials
		expect(await relayIceServers()).toEqual([]);
		answer = async () => ({ iceServers: relay('back'), expiresAt: Date.now() + 600_000 });
		await prefetchRelay();
		expect(await relayIceServers()).toEqual(relay('back'));
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
