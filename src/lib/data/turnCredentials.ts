// Relay credentials for the optical handshake (docs/task-handshake-pq2.md §5a;
// chat: docs/pq/reqs/pq_turn_relay.proposed.md § Endpoint). Two phones on
// mobile data share no network and reach each other only through our TURN
// relay; on one network ICE still picks the direct path.
//
// The add-contact view asks for them when it opens, one screen before the
// scanner (prefetchRelay); a session takes what is cached, or waits at most
// 1 s for a request in flight (relayIceServers). Anything that is not a
// usable credential — offline, a 503 turn_unavailable, a 429, no answer, an
// endpoint the backend does not have yet — is "no relay": the handshake goes
// on with the phone's own addresses, which is all a shared network needs.
//
// Credentials live in memory only, per account. They are renewed in the
// background once less than 150 s remain (half the lifetime, for a credential
// that lives less than 300 s), and a session takes one only while it lasts the
// session: 90 s, then 15 s for the channel and 10 s for the confirmation, with
// a margin. A credential the session would outlive is refused by the relay
// mid-session; until a fresh one arrives the old one is still used rather
// than none, as long as it is valid. A failure is remembered too, for a minute or the server's
// Retry-After: opening the view and starting the scanner do not each pay for a
// challenge, an ML-DSA signature and a POST that will fail the same way.
/* global RTCIceServer -- a DOM type */
import { api } from '@/api/client';
import { proveChallenge } from '@/lib/pq/challengeProof';

declare const ELECTRIC_API_URL: string;
/** The dev server's static relay (vite.config.js), null in every build. */
declare const HANDSHAKE_DEV_TURN: RTCIceServer | null;

export interface RelayCredentials {
	iceServers: RTCIceServer[];
	/** Epoch ms. */
	expiresAt: number;
}

/** No credentials, and when to ask again (ms); without it, after FAILURE_RETRY_MS. */
export interface RelayRefusal {
	retryAfterMs?: number;
}

/** Where credentials come from: the backend endpoint, a dev-only static relay, or a test's stand-in. */
export type RelaySource = (account: string) => Promise<RelayCredentials | RelayRefusal>;

export const RENEW_BEFORE_MS = 150_000;
/** What a session needs of its credential: 90 s + 15 s + 10 s, and a margin. */
export const SESSION_LIFETIME_MS = 125_000;
export const SESSION_WAIT_MS = 1_000;
export const FAILURE_RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** The endpoint answers two URIs, UDP and TCP; the browser allocates a relay on every one it is given. */
const MAX_URIS = 2;

type EncryptionManager = InstanceType<typeof import('@/libs/EncryptionManagerPQ').EncryptionManagerPQ>;

const manager = async (): Promise<EncryptionManager> =>
	(await import('@/libs/EncryptionManagerPQ')).EncryptionManagerPQ.getInstance();

/** POST /electric/v1/turn_credentials, proved like ingest and read sessions. */
const fromEndpoint: RelaySource = async (account) => {
	const em = await manager();
	if (!em.isAuth || em.currentUserHash !== account) return {};
	const { challenge_id, challenge } = await api.getChallenge();
	if (typeof challenge_id !== 'string' || typeof challenge !== 'string') return {};
	const signature = await proveChallenge(challenge, (message) => em.signChallenge(message));
	const resp = await fetch(`${ELECTRIC_API_URL}/turn_credentials`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_hash: account, challenge_id, signature }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (resp.status === 429) return { retryAfterMs: await retryAfterOf(resp) };
	if (!resp.ok) return {};
	return credentialsOf(await resp.json(), Date.now()) ?? {};
};

/** A 429's wait: the body's retry_after, else the Retry-After header, in seconds. */
const retryAfterOf = async (resp: Response): Promise<number | undefined> => {
	const body = (await resp.json().catch(() => null)) as { retry_after?: unknown } | null;
	const seconds = Number(body?.retry_after ?? resp.headers.get('Retry-After'));
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/** A 200 body as RTCIceServers, or null when it is not one. */
export const credentialsOf = (body: unknown, now: number): RelayCredentials | null => {
	const { username, credential, ttl, uris } = (body ?? {}) as Record<string, unknown>;
	if (typeof username !== 'string' || typeof credential !== 'string') return null;
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) return null;
	const urls = Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string' && /^turns?:/i.test(u)).slice(0, MAX_URIS) : [];
	if (!urls.length) return null;
	return { iceServers: [{ urls, username, credential }], expiresAt: now + ttl * 1000 };
};

/**
 * A local TURN server with a static user, until the backend endpoint exists:
 * HANDSHAKE_TURN_URL, …_USER and …_PASS in the environment or .env.local, e.g.
 * a coturn container. vite.config.js puts them in HANDSHAKE_DEV_TURN on the
 * dev server only, and null into every build: no VITE_ prefix, so nothing
 * inlines them into a bundle. Goes when the endpoint lands.
 */
const devRelay = (): RelaySource | null => {
	const relay = typeof HANDSHAKE_DEV_TURN === 'undefined' ? null : HANDSHAKE_DEV_TURN;
	return relay ? async () => ({ iceServers: [relay], expiresAt: Number.POSITIVE_INFINITY }) : null;
};

let source: RelaySource = devRelay() ?? fromEndpoint;
let cached: { account: string; credentials: RelayCredentials; renewAt: number } | null = null;
let inflight: { account: string; promise: Promise<RelayCredentials | null> } | null = null;
let failed: { account: string; until: number } | null = null;

/** This account's credential while it is valid at all. */
const valid = (account: string, now = Date.now()): RelayCredentials | null =>
	cached && cached.account === account && now < cached.credentials.expiresAt ? cached.credentials : null;

/** It lasts a whole session from now. */
const lastsSession = (c: RelayCredentials, now = Date.now()): boolean => c.expiresAt - now >= SESSION_LIFETIME_MS;

/** Time to ask for the next: less than 150 s left, or half a short credential's lifetime. */
const renewalDue = (account: string, now = Date.now()): boolean =>
	!valid(account, now) || now >= cached!.renewAt;

const renewAtOf = (c: RelayCredentials, now: number): number =>
	c.expiresAt - Math.min(RENEW_BEFORE_MS, (c.expiresAt - now) / 2);

/** A request for this account failed a moment ago: asking again now would fail the same way. */
const backingOff = (account: string, now = Date.now()): boolean => failed?.account === account && now < failed.until;

const request = (account: string): Promise<RelayCredentials | null> => {
	if (inflight?.account === account) return inflight.promise;
	const promise: Promise<RelayCredentials | null> = source(account)
		.catch((e: unknown): RelayRefusal => {
			console.warn('[relay] no relay credentials:', e instanceof Error ? e.message : e);
			return {};
		})
		.then((answer) => {
			if (inflight?.promise !== promise) return null; // cleared meanwhile: logout, account switch
			inflight = null;
			if ('iceServers' in answer) {
				cached = { account, credentials: answer, renewAt: renewAtOf(answer, Date.now()) };
				failed = null;
				return answer;
			}
			failed = { account, until: Date.now() + (answer.retryAfterMs ?? FAILURE_RETRY_MS) };
			return null;
		});
	inflight = { account, promise };
	return promise;
};

const currentAccount = async (): Promise<string | null> => {
	try {
		const em = await manager();
		return em.isAuth ? (em.currentUserHash as string | null) : null;
	} catch {
		return null;
	}
};

/** Starts a request when renewal is due and no failure is being waited out. Never throws. */
export const prefetchRelay = async (): Promise<void> => {
	const account = await currentAccount();
	if (account && renewalDue(account) && !backingOff(account)) void request(account);
};

/**
 * The ICE servers for a session that starts now: the relay, or `[]` when
 * there is none within `waitMs`. Never throws, and never waits longer.
 */
export const relayIceServers = async (waitMs = SESSION_WAIT_MS): Promise<RTCIceServer[]> => {
	const deadline = Date.now() + waitMs;
	const account = await Promise.race([currentAccount(), timeout(waitMs, null)]);
	if (!account) return [];
	if (renewalDue(account) && !backingOff(account)) {
		const renewal = request(account); // in the background, unless what is held will not last
		const held = valid(account);
		if (!held || !lastsSession(held)) await Promise.race([renewal, timeout(Math.max(0, deadline - Date.now()), null)]);
	}
	// The freshest valid credential held: one that is short of the session's
	// lifetime still beats none, which would leave phones on two networks apart.
	return valid(account)?.iceServers ?? [];
};

const timeout = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** Drops what is cached (logout, account switch); a request in flight is no longer kept. */
export const clearRelayCredentials = (): void => {
	cached = null;
	inflight = null;
	failed = null;
};

export function _setRelaySourceForTests(next: RelaySource | null): void {
	source = next ?? devRelay() ?? fromEndpoint;
	clearRelayCredentials();
}
