// Per-shape read session tokens for Electric access gating (trust mode).
//
// The server gates shape reads with Bearer tokens issued via POST /read_session
// after a PoP challenge. This module owns the token lifecycle: lazy open on
// first 401, deduplication of concurrent opens, renewal before expiry, and
// the synchronous bearerFor() that Electric's header resolver calls on every
// long-poll.
//
// Tokens live in memory only — they are secrets (spec §7) and survive neither
// reload nor logout. A server restart drops all sessions; a 401 on a locally
// valid token triggers a fresh open.

import { toBase64 } from '@/lib/pq/signature';
import { markShapeBlocked, markShapeUnblocked, isShapeBlocked } from './accessGate';

declare const ELECTRIC_API_URL: string;

interface ReadSessionEntry {
	token: string;
	shape: string;
	expiresAt: number;
	renewTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, ReadSessionEntry>();
const inflight = new Map<string, Promise<ReadSessionEntry | null>>();

const RENEW_AHEAD_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

// ---------- public API ----------

export function bearerFor(shape: string): string {
	const entry = sessions.get(shape);
	if (!entry || Date.now() >= entry.expiresAt) return '';
	return `Bearer ${entry.token}`;
}

export function hasValidToken(shape: string): boolean {
	const entry = sessions.get(shape);
	return !!entry && Date.now() < entry.expiresAt;
}

export async function handleShapeAuth401(json: { error: string; shape: string }): Promise<boolean> {
	const { shape } = json;
	invalidateSession(shape);
	const entry = await openSession(shape);
	return entry !== null;
}

export async function openSession(shape: string): Promise<string | null> {
	const existing = inflight.get(shape);
	if (existing) {
		const result = await existing;
		return result?.token ?? null;
	}

	const promise = doOpen(shape);
	inflight.set(shape, promise);
	try {
		const result = await promise;
		return result?.token ?? null;
	} finally {
		inflight.delete(shape);
	}
}

export function invalidateSession(shape: string): void {
	const entry = sessions.get(shape);
	if (entry?.renewTimer) clearTimeout(entry.renewTimer);
	sessions.delete(shape);
}

export function clearSessions(): void {
	for (const entry of sessions.values()) {
		if (entry.renewTimer) clearTimeout(entry.renewTimer);
	}
	sessions.clear();
	inflight.clear();
}

// ---------- internals ----------

async function doOpen(shape: string): Promise<ReadSessionEntry | null> {
	const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
	const em = EncryptionManagerPQ.getInstance();
	if (!em.isAuth) return null;

	const userHash = em.currentUserHash as string | null;
	if (!userHash) return null;
	const challengeResp = await fetchChallenge();
	const sigBytes: Uint8Array = await em.signChallenge(challengeResp.challenge);
	const signature = toBase64(sigBytes).replace(/=+$/, '');

	const resp = await fetch(`${ELECTRIC_API_URL}/read_session`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			user_hash: userHash,
			shape,
			challenge_id: challengeResp.challenge_id,
			signature,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (resp.ok) {
		const body = await resp.json() as { token: string; shape: string; expires_in: number };
		const entry: ReadSessionEntry = {
			token: body.token,
			shape: body.shape,
			expiresAt: Date.now() + body.expires_in * 1000,
			renewTimer: null,
		};
		sessions.set(body.shape, entry);
		scheduleRenewal(entry);
		if (isShapeBlocked(body.shape)) markShapeUnblocked(body.shape);
		return entry;
	}

	if (resp.status === 403) {
		const body = await resp.json().catch(() => null) as { error?: string } | null;
		if (body?.error === 'not_in_trust_chain') {
			markShapeBlocked(shape);
			return null;
		}
	}

	if (resp.status === 401) {
		return null;
	}

	if (resp.status === 400) {
		return null;
	}

	throw new Error(`read_session for ${shape}: HTTP ${resp.status}`);
}

async function fetchChallenge(): Promise<{ challenge_id: string; challenge: string }> {
	const resp = await fetch(`${ELECTRIC_API_URL}/challenge`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw new Error(`challenge: HTTP ${resp.status}`);
	return resp.json();
}

function scheduleRenewal(entry: ReadSessionEntry): void {
	if (entry.renewTimer) clearTimeout(entry.renewTimer);
	const delay = Math.max(entry.expiresAt - Date.now() - RENEW_AHEAD_MS, 1000);
	entry.renewTimer = setTimeout(() => {
		entry.renewTimer = null;
		if (!sessions.has(entry.shape)) return;
		void openSession(entry.shape);
	}, delay);
}
