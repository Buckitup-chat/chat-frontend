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
// Credentials live in memory only, per account, and are asked for again when
// less than 150 s remain: a session (90 s, then 15 s for the channel and 10 s
// for the confirmation) must not outlive its credential, or the relay refuses
// it mid-session.
/* global RTCIceServer -- a DOM type */
import { api } from '@/api/client';
import { proveChallenge } from '@/lib/pq/challengeProof';

declare const ELECTRIC_API_URL: string;

export interface RelayCredentials {
	iceServers: RTCIceServer[];
	/** Epoch ms. */
	expiresAt: number;
}

/** Where credentials come from: the backend endpoint, a dev-only static relay, or a test's stand-in. */
export type RelaySource = (account: string) => Promise<RelayCredentials | null>;

export const RENEW_BEFORE_MS = 150_000;
export const SESSION_WAIT_MS = 1_000;
const FETCH_TIMEOUT_MS = 10_000;
/** The endpoint answers two URIs, UDP and TCP; the browser allocates a relay on every one it is given. */
const MAX_URIS = 2;

type EncryptionManager = InstanceType<typeof import('@/libs/EncryptionManagerPQ').EncryptionManagerPQ>;

const manager = async (): Promise<EncryptionManager> =>
	(await import('@/libs/EncryptionManagerPQ')).EncryptionManagerPQ.getInstance();

/** POST /electric/v1/turn_credentials, proved like ingest and read sessions. */
const fromEndpoint: RelaySource = async (account) => {
	const em = await manager();
	if (!em.isAuth || em.currentUserHash !== account) return null;
	const { challenge_id, challenge } = await api.getChallenge();
	if (typeof challenge_id !== 'string' || typeof challenge !== 'string') return null;
	const signature = await proveChallenge(challenge, (message) => em.signChallenge(message));
	const resp = await fetch(`${ELECTRIC_API_URL}/turn_credentials`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ user_hash: account, challenge_id, signature }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) return null;
	return credentialsOf(await resp.json(), Date.now());
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
 * VITE_HANDSHAKE_TURN_URL, …_USER and …_PASS, e.g. a coturn container. Read
 * only on the dev server: Vite inlines any VITE_* value set at build time, so
 * without the guard a developer's .env.local or a hosting variable would put
 * the password into the deployed bundle. Goes when the endpoint lands.
 */
const devRelay = (): RelaySource | null => {
	if (!import.meta.env.DEV) return null;
	const url = import.meta.env.VITE_HANDSHAKE_TURN_URL as string | undefined;
	if (!url) return null;
	const relay: RTCIceServer = {
		urls: url,
		username: (import.meta.env.VITE_HANDSHAKE_TURN_USER as string | undefined) ?? '',
		credential: (import.meta.env.VITE_HANDSHAKE_TURN_PASS as string | undefined) ?? '',
	};
	return async () => ({ iceServers: [relay], expiresAt: Number.POSITIVE_INFINITY });
};

let source: RelaySource = devRelay() ?? fromEndpoint;
let cached: { account: string; credentials: RelayCredentials } | null = null;
let inflight: { account: string; promise: Promise<RelayCredentials | null> } | null = null;

const usable = (account: string, now = Date.now()): RelayCredentials | null =>
	cached && cached.account === account && cached.credentials.expiresAt - now >= RENEW_BEFORE_MS ? cached.credentials : null;

const request = (account: string): Promise<RelayCredentials | null> => {
	if (inflight?.account === account) return inflight.promise;
	const promise = source(account)
		.catch((e: unknown) => {
			console.warn('[relay] no relay credentials:', e instanceof Error ? e.message : e);
			return null;
		})
		.then((credentials) => {
			if (inflight?.promise === promise) inflight = null;
			if (credentials) cached = { account, credentials };
			return credentials;
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

/** Starts a request unless a usable credential is cached or one is on its way. Never throws. */
export const prefetchRelay = async (): Promise<void> => {
	const account = await currentAccount();
	if (account && !usable(account)) void request(account);
};

/**
 * The ICE servers for a session that starts now: the relay, or `[]` when
 * there is none within `waitMs`. Never throws, and never waits longer.
 */
export const relayIceServers = async (waitMs = SESSION_WAIT_MS): Promise<RTCIceServer[]> => {
	const deadline = Date.now() + waitMs;
	const account = await Promise.race([currentAccount(), timeout(waitMs, null)]);
	if (!account) return [];
	const ready = usable(account);
	if (ready) return ready.iceServers;
	const credentials = await Promise.race([request(account), timeout(Math.max(0, deadline - Date.now()), null)]);
	return credentials && usable(account) ? credentials.iceServers : [];
};

const timeout = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** Drops what is cached (logout, account switch); a request in flight is no longer kept. */
export const clearRelayCredentials = (): void => {
	cached = null;
	inflight = null;
};

export function _setRelaySourceForTests(next: RelaySource | null): void {
	source = next ?? devRelay() ?? fromEndpoint;
	clearRelayCredentials();
}
