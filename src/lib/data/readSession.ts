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

import { markShapeBlocked, markShapeUnblocked, isShapeBlocked } from './accessGate';
import { transport } from './transport';

interface ReadSessionEntry {
	token: string;
	shape: string;
	expiresAt: number;
	renewTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, ReadSessionEntry>();
const inflight = new Map<string, Promise<ReadSessionEntry | null>>();
const tableShapes = new Map<string, string>();
let generation = 0;

type CardRecovery = 'accepted' | 'stale';
const cardRecoveries = new Map<string, Promise<CardRecovery>>();
let cardRecoveryEpoch = 0;
const cardRecoveryEnded = new Map<string, Error | null>();

const RENEW_AHEAD_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

// ---------- public API ----------

export function bearerFor(shapeOrTable: string): string {
	const entry = sessions.get(tableShapes.get(shapeOrTable) ?? shapeOrTable);
	if (!entry || Date.now() >= entry.expiresAt) return '';
	return `Bearer ${entry.token}`;
}

export function hasValidToken(shape: string): boolean {
	const entry = sessions.get(shape);
	return !!entry && Date.now() < entry.expiresAt;
}

export async function handleShapeAuth401(json: { error: string; shape: string }, table?: string): Promise<boolean> {
	const { shape } = json;
	if (table) tableShapes.set(table, shape);
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

	const promise = doOpen(shape, generation);
	inflight.set(shape, promise);
	try {
		const result = await promise;
		return result?.token ?? null;
	} finally {
		if (inflight.get(shape) === promise) inflight.delete(shape);
	}
}

export function invalidateSession(shape: string): void {
	const entry = sessions.get(shape);
	if (entry?.renewTimer) clearTimeout(entry.renewTimer);
	sessions.delete(shape);
}

export async function whenSignedIn(): Promise<void> {
	const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
	const em = EncryptionManagerPQ.getInstance();
	if (em.isAuth) return;
	await new Promise<void>((resolve) => {
		const onAuthChange = (event: Event) => {
			if (!(event as CustomEvent<{ isAuthenticated?: boolean }>).detail?.isAuthenticated) return;
			em.removeEventListener('authChange', onAuthChange);
			resolve();
		};
		em.addEventListener('authChange', onAuthChange);
	});
}

export function clearSessions(): void {
	for (const entry of sessions.values()) {
		if (entry.renewTimer) clearTimeout(entry.renewTimer);
	}
	sessions.clear();
	inflight.clear();
	tableShapes.clear();
	cardRecoveries.clear();
	cardRecoveryEnded.clear();
	generation++;
}

// ---------- internals ----------

type EncryptionManager = InstanceType<typeof import('@/libs/EncryptionManagerPQ').EncryptionManagerPQ>;
const UNKNOWN_USER = Symbol('unknown_user');
const STALE = Symbol('stale');

async function doOpen(shape: string, gen: number): Promise<ReadSessionEntry | null> {
	const stale = () => gen !== generation;
	const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
	if (stale()) return null;
	const em = EncryptionManagerPQ.getInstance();
	if (!em.isAuth) return null;

	const userHash = em.currentUserHash as string | null;
	if (!userHash) return null;
	const epoch = cardRecoveryEpoch;
	const first = await requestSession(em, userHash, shape, stale);
	if (first !== UNKNOWN_USER) return first;

	if (!(await recoverCard(em, userHash, epoch, stale)) || stale()) return null;
	const retry = await requestSession(em, userHash, shape, stale);
	if (retry !== UNKNOWN_USER) return retry;
	if (!stale()) cardRecoveryEnded.set(userHash, null);
	return null;
}

async function recoverCard(em: EncryptionManager, userHash: string, epoch: number, stale: () => boolean): Promise<boolean> {
	if (cardRecoveryEnded.has(userHash)) {
		const failure = cardRecoveryEnded.get(userHash);
		if (failure) throw failure;
		return false;
	}
	if (epoch !== cardRecoveryEpoch) return true;
	let recovery = cardRecoveries.get(userHash);
	if (!recovery) {
		recovery = em.recoverOwnCard(userHash) as Promise<CardRecovery>;
		const running = recovery;
		cardRecoveries.set(userHash, running);
		void running.then(
			(outcome) => { if (outcome === 'accepted' && cardRecoveries.get(userHash) === running) cardRecoveryEpoch++; },
			(e: unknown) => { if (cardRecoveries.get(userHash) === running) cardRecoveryEnded.set(userHash, e instanceof Error ? e : new Error(String(e))); },
		).finally(() => { if (cardRecoveries.get(userHash) === running) cardRecoveries.delete(userHash); });
	}
	try {
		return (await recovery) === 'accepted';
	} catch (e) {
		if (stale()) return false;
		throw e;
	}
}

async function requestSession(
	em: EncryptionManager, userHash: string, shape: string, stale: () => boolean,
): Promise<ReadSessionEntry | null | typeof UNKNOWN_USER> {
	// A session ended while the challenge was in flight signs nothing.
	const sign = (message: Uint8Array) => {
		if (stale()) throw STALE;
		return em.signChallenge(message);
	};
	let outcome;
	try {
		outcome = await transport.openReadSession(userHash, shape, sign, { timeoutMs: FETCH_TIMEOUT_MS });
	} catch (e) {
		if (e === STALE) return null;
		throw e;
	}
	if (stale()) return null;

	switch (outcome.kind) {
		case 'opened': {
			const entry: ReadSessionEntry = { token: outcome.token, shape: outcome.shape, expiresAt: outcome.expiresAt, renewTimer: null };
			sessions.set(outcome.shape, entry);
			scheduleRenewal(entry);
			if (isShapeBlocked(outcome.shape)) markShapeUnblocked(outcome.shape);
			return entry;
		}
		case 'not_in_trust_chain':
			markShapeBlocked(shape);
			return null;
		case 'unknown_user':
			return UNKNOWN_USER;
		case 'refused':
			// A bad challenge or signature (401) or an unknown shape (400) ends this
			// attempt; any other refusal is not one the protocol defines.
			if (outcome.status === 401 || outcome.status === 400) return null;
			throw new Error(`read_session for ${shape}: HTTP ${outcome.status}`);
	}
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
