// Per-shape read session tokens for Electric access gating (trust mode).
//
// The server gates shape reads with Bearer tokens issued via POST /read_session
// after a PoP challenge. The SDK owns lazy opening, concurrent-open
// deduplication and renewal. This adapter binds it to the active account,
// card recovery and approval UI, and exposes the synchronous bearerFor()
// that Electric's header resolver calls on every long-poll.
//
// Tokens live in memory only — they are secrets (spec §7) and survive neither
// reload nor logout. A server restart drops all sessions; a 401 on a locally
// valid token triggers a fresh open.

import {
	createReadSessions,
	type ReadSessionOpenContext,
	type ReadSessionOutcome,
	type ReadSessionResult,
	type ReadSessions,
} from '@buckitup/pq-client/transport';
import { markShapeBlocked, markShapeUnblocked, isShapeBlocked } from './accessGate';
import { transport } from './transport';

let current: ReadSessions | null = null;
let generation = 0;

type CardRecovery = 'accepted' | 'stale';
const cardRecoveries = new Map<string, Promise<CardRecovery>>();
let cardRecoveryEpoch = 0;
const cardRecoveryEnded = new Map<string, Error | null>();

const FETCH_TIMEOUT_MS = 15_000;

let encryptionManagerModule: Promise<typeof import('@/libs/EncryptionManagerPQ')> | null = null;
const loadEncryptionManager = () => (encryptionManagerModule ??= import('@/libs/EncryptionManagerPQ'));

// ---------- public API ----------

export function bearerFor(shapeOrTable: string): string {
	return current?.bearer(shapeOrTable) ?? '';
}

export function hasValidToken(shape: string): boolean {
	return current?.hasValidToken(shape) ?? false;
}

export async function handleShapeAuth401(json: { error: string; shape: string }, table?: string): Promise<boolean> {
	const sessions = await signedInSessions();
	if (!sessions) return false;
	return tokenOf(json.shape, await sessions.reopen(json.shape, table)) !== null;
}

export async function openSession(shape: string): Promise<string | null> {
	const sessions = await signedInSessions();
	if (!sessions) return null;
	return tokenOf(shape, await sessions.open(shape));
}

export function invalidateSession(shape: string): void {
	current?.invalidate(shape);
}

export async function whenSignedIn(): Promise<void> {
	const { EncryptionManagerPQ } = await loadEncryptionManager();
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
	current?.dispose();
	current = null;
	cardRecoveries.clear();
	cardRecoveryEnded.clear();
	generation++;
}

// ---------- internals ----------

type EncryptionManager = InstanceType<typeof import('@/libs/EncryptionManagerPQ').EncryptionManagerPQ>;

function tokenOf(shape: string, result: ReadSessionResult): string | null {
	if (result.kind === 'opened') return result.token;
	if (result.kind === 'refused') throw new Error(`read_session for ${shape}: HTTP ${result.status}`);
	return null;
}

async function signedInSessions(): Promise<ReadSessions | null> {
	const gen = generation;
	const { EncryptionManagerPQ } = await loadEncryptionManager();
	if (gen !== generation) return null;
	const em = EncryptionManagerPQ.getInstance();
	if (!em.isAuth) return null;
	const userHash = em.currentUserHash as string | null;
	if (!userHash) return null;
	if (current && current.userHash !== userHash) {
		current.dispose();
		current = null;
	}
	current ??= createReadSessions({
		transport,
		identity: { userHash, sign: (message) => em.signChallenge(message) },
		timeoutMs: FETCH_TIMEOUT_MS,
		openSession: (shape, context) => openWithCardRecovery(em, shape, context, gen),
		onOutcome: noteOutcome,
	});
	return current;
}

function noteOutcome(shape: string, outcome: ReadSessionOutcome): void {
	if (outcome.kind === 'opened' && isShapeBlocked(outcome.shape)) markShapeUnblocked(outcome.shape);
	if (outcome.kind === 'not_in_trust_chain') markShapeBlocked(shape);
}

async function openWithCardRecovery(
	em: EncryptionManager, shape: string, context: ReadSessionOpenContext, gen: number,
): Promise<ReadSessionOutcome> {
	const stale = () => gen !== generation;
	const epoch = cardRecoveryEpoch;
	const request = { signal: context.signal };
	const first = await transport.openReadSession(context.userHash, shape, context.sign, request);
	if (first.kind !== 'unknown_user') return first;

	if (!(await recoverCard(em, context.userHash, epoch, stale)) || stale()) return first;
	const retry = await transport.openReadSession(context.userHash, shape, context.sign, request);
	if (retry.kind === 'unknown_user' && !stale()) cardRecoveryEnded.set(context.userHash, null);
	return retry;
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
