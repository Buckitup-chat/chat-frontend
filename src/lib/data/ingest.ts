// Durable application writes over the SDK's /ingest_each transport and
// per-row outcome classification. Each row is committed independently;
// earlier accepted rows remain committed if a later row is refused. The app
// retains outbox state and uses txids to reconcile optimistic collections.
//
// Idempotency: a unique-key conflict ("has already been taken") is NOT
// success by itself — the server row may be a different revision, and
// swallowing the conflict silently loses updates. The retry wrapper treats a
// conflict as applied only after proving the server row carries our exact
// signature (see confirm.ts).
import { api } from '@/api/client';
import { unanswered } from './transport';
import { mutationAppliedOnServer, derivedRowAppliedOnServer, type MutationLike } from './confirm';
import { discoverDependencies, reconcileAccepted } from './coordinator';
import { OWNER_FIELD, ownerOf } from './writeContracts';
import { VaultLockedError, AccountMismatchError, resolveSigningKey, type SigningKeySource } from './keyCustody';
import { derivedSigner, sessionAccount, type DerivedSigner } from './sessionIdentities';
import { readDeviceIdentity } from './deviceOwner';
import { readShapeOnce } from './shapeRead';
import {
	enqueue, stopDrainLoop as stopOutboxLoop, awaitEntryOutcome, dependencyBlockFor, wakeAccountSender, releaseNetworkBackoffs,
	approvalHeldShapes, approvalProbeCandidate, sendApprovalProbe, onApprovalHeldChange, AWAITING_APPROVAL_MESSAGE,
	awaitDeliveryVerdict, submitEntryToSender, SessionFencedError,
	type HeldReason, type DeliveryVerdict, type DiscoveryOutcome, type EntryOutcome, type OutboxEntry,
} from './outbox';
import { setWriteProber, syncBlockedWrites } from './accessGate';
import type { IngestRowResult } from '@buckitup/pq-client/types';
import {
	checkResults, classifyRowResult, NOT_IN_TRUST_CHAIN, TransportError, validationReasons,
	type ValidationReason, type WriteRejection,
} from '@buckitup/pq-client/transport';

export class IngestError extends Error {
	/** true when retrying can never succeed (server-side validation) */
	permanent: boolean;
	/** true when every failed row is a unique-key conflict — candidate for identity check */
	uniqueConflictOnly: boolean;
	/** indexes of the rows that actually conflicted (never rows the server accepted) */
	conflictIndexes: number[];
	status: number | null;
	results: IngestRowResult[] | null;
	/** true when no answer came back at all: a fact about connectivity, not about this write */
	network: boolean;
	approvalBlocked: boolean;
	blockedIndexes: number[];

	constructor(
		message: string,
		opts: {
			permanent?: boolean;
			uniqueConflictOnly?: boolean;
			conflictIndexes?: number[];
			status?: number | null;
			results?: IngestRowResult[] | null;
			network?: boolean;
			approvalBlocked?: boolean;
			blockedIndexes?: number[];
		} = {}
	) {
		super(message);
		this.name = 'IngestError';
		this.permanent = opts.permanent ?? false;
		this.uniqueConflictOnly = opts.uniqueConflictOnly ?? false;
		this.conflictIndexes = opts.conflictIndexes ?? [];
		this.status = opts.status ?? null;
		this.results = opts.results ?? null;
		this.network = opts.network ?? false;
		this.approvalBlocked = opts.approvalBlocked ?? false;
		this.blockedIndexes = opts.blockedIndexes ?? [];
	}
}

export { NOT_IN_TRUST_CHAIN };

const rejectionOf = (r: IngestRowResult): WriteRejection | null => {
	const outcome = classifyRowResult(r);
	return outcome.kind === 'rejected' ? outcome.rejection : null;
};

const isApprovalBlocked = (r: IngestRowResult): boolean => rejectionOf(r)?.kind === 'gate';

const validationHas = (r: IngestRowResult, reason: ValidationReason): boolean =>
	r.status === 'error' && r.error === 'validation_failed' && validationReasons(r.details).has(reason);

const isUniqueConflict = (r: IngestRowResult): boolean => validationHas(r, 'unique_conflict');

const isTimestampNotNewer = (r: IngestRowResult): boolean => validationHas(r, 'stale_timestamp');

const isExistsConflict = (r: IngestRowResult): boolean => rejectionOf(r)?.kind === 'exists';

function validateBatchResults(results: unknown, mutationCount: number, status: number): IngestRowResult[] {
	try {
		return checkResults(results, mutationCount, status);
	} catch (e) {
		if (e instanceof TransportError) throw new IngestError(e.message, { permanent: false, status });
		throw e;
	}
}

export interface SendResult {
	txids: number[];
	results: IngestRowResult[];
}

/**
 * Send one logical transaction of mutations. Throws IngestError:
 * permanent=true → drop the write (rollback optimistic state, surface to UI),
 * permanent=false → transient, caller may retry.
 * uniqueConflictOnly=true → all failures are key conflicts; the retry wrapper
 * may resolve them via the signature identity check.
 */
export async function sendMutations(mutations: unknown[], signSkey: Uint8Array): Promise<SendResult> {
	let resp: Response;
	try {
		resp = await api.ingestWithAuthEach(mutations, signSkey);
	} catch (e) {
		if (e instanceof VaultLockedError || e instanceof AccountMismatchError) throw e;
		// Only a request that got no answer — fetch failed or timed out — is a
		// fact about connectivity; a server that answered with garbage is not.
		throw new IngestError(`ingest network error: ${e}`, { permanent: false, network: unanswered(e) });
	}

	// The server reports per-row outcomes in the body even on 4xx.
	let body: { results?: IngestRowResult[] } | null = null;
	try {
		body = await resp.json();
	} catch {
		/* non-JSON body */
	}

	const results = validateBatchResults(body?.results, mutations.length, resp.status);

	// A PK conflict the server can resolve itself against a registered Shape
	// module comes back as status "exists" (HTTP 200, not "error"), with its
	// own verdict on whether our row IS the stored one: `conflicted: false`
	// is an idempotent retry — already applied by an earlier attempt whose
	// response we never saw — and must be treated as success, not failure.
	// `conflicted: true` is a genuine different-revision conflict and, like
	// the text-matched fallback below, a final verdict worth retrying.
	const isResolvedConflict = (r: IngestRowResult): boolean => {
		const rejection = rejectionOf(r);
		return rejection?.kind === 'exists' && !rejection.conflicted;
	};

	const failed = results.filter((r) => r.status !== 'ok' && !isResolvedConflict(r));
	const blockedIndexes = failed.filter(isApprovalBlocked).map((r) => r.index);
	if (failed.length > 0 && blockedIndexes.length === failed.length) {
		throw new IngestError(
			`ingest: ${blockedIndexes.length}/${results.length} rows wait for approval by the device owner (${NOT_IN_TRUST_CHAIN})`,
			{ permanent: false, approvalBlocked: true, blockedIndexes, status: resp.status, results }
		);
	}
	if (failed.length > 0) {
		// A 422 row outcome is the server's final verdict — validation or a
		// business rule (e.g. "cannot react to own message"). Retrying the
		// same signed mutation can never change it; only network-level
		// failures (5xx, 429, no response) are worth retrying.
		const permanent = resp.status === 422;
		const isConflict = (r: IngestRowResult) => isExistsConflict(r) || isUniqueConflict(r) || isTimestampNotNewer(r);
		const uniqueConflictOnly = failed.every(isConflict);
		// Only the rows the server actually rejected need an identity check;
		// rows it reported as ok are already confirmed by this response and
		// must not be made to depend on shape propagation.
		const conflictIndexes = failed.filter(isConflict).map((r) => r.index);
		throw new IngestError(
			`ingest rejected ${failed.length}/${results.length} rows: ${JSON.stringify(failed[0]?.details || failed[0]?.error)}`,
			{ permanent, uniqueConflictOnly, conflictIndexes, blockedIndexes, status: resp.status, results }
		);
	}

	return {
		txids: results.filter((r) => typeof r.txid === 'number').map((r) => r.txid as number),
		results,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
	retries?: number;
	/**
	 * In-process retries after a request that got no answer at all; defaults
	 * to `retries`. A write already in the outbox keeps at most one: beyond a
	 * lost response its retry belongs to the outbox schedule, and waiting here
	 * would hold the send lock that every other write of the account needs.
	 */
	networkRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Identity check for unique-key conflicts; overridable for tests. */
	confirmApplied?: (mutation: MutationLike, opts?: { attempts?: number; delayMs?: number }) => Promise<boolean>;
}

/**
 * sendMutations + exponential backoff for transient failures.
 *
 * A unique-conflict outcome is resolved through the identity check: if the
 * server already holds exactly our signed rows (e.g. a retry after a network
 * error where the first attempt actually landed), that is success; otherwise
 * it is a permanent conflict surfaced to the caller.
 */
export async function sendMutationsWithRetry(
	mutations: unknown[],
	signSkey: Uint8Array,
	opts: RetryOptions = {}
): Promise<SendResult> {
	const {
		retries = 4,
		baseDelayMs = 1000,
		maxDelayMs = 30000,
		confirmApplied = mutationAppliedOnServer,
	} = opts;
	const networkRetries = opts.networkRetries ?? retries;
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await sendMutations(mutations, signSkey);
		} catch (e) {
			lastError = e;

			if (e instanceof IngestError && e.uniqueConflictOnly) {
				const confirmations = await Promise.all(
					e.conflictIndexes.map((index) => confirmApplied(mutations[index] as MutationLike))
				);
				if (confirmations.every(Boolean)) {
					const txids = (e.results ?? [])
						.filter((r) => typeof r.txid === 'number')
						.map((r) => r.txid as number);
					return { txids, results: e.results ?? [] };
				}
				throw new IngestError('conflicting row already exists on the server with different content', {
					permanent: true,
					uniqueConflictOnly: true,
					conflictIndexes: e.conflictIndexes,
					status: e.status,
					results: e.results,
				});
			}

			if (e instanceof IngestError && (e.permanent || e.approvalBlocked)) throw e;
			if (e instanceof VaultLockedError || e instanceof AccountMismatchError) throw e;
			if (attempt === retries) break;
			if (e instanceof IngestError && e.network && attempt >= networkRetries) break;
			const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
			await sleep(delay + Math.random() * delay * 0.25);
		}
	}
	throw lastError;
}

// Re-exported so callers can attribute a durable intent (intents.ts, §3.1) to
// its owner before a mutation exists to read syncMetadata.relation from.
export { OWNER_FIELD };

/** Durable storage refused the write — the mutation was NOT sent. */
export class DurabilityError extends Error {
	constructor() {
		super('This message could not be stored for sending. Nothing was sent — try again.');
		this.name = 'DurabilityError';
	}
}

export interface DeliveryHandle {
	outboxId: string | null;
	phase: 'accepted' | 'queued';
	result?: SendResult;
	acceptance: Promise<EntryOutcome>;
	held?: { reason: HeldReason | 'state_unconfirmed'; message: string };
}

export interface LiveSendOptions {
	onDurable?: (outboxId: string) => void | Promise<void>;
	sourceIntentId?: string;
	excludeFromDependencies?: string[];
	targeted?: boolean;
	fileIds?: string[];
	/** The write is signed by this identity derived from the open account, not by the account. */
	signer?: DerivedSigner;
}

export async function sendMutationsAndAwaitShape(
	mutations: unknown[],
	signSkey: SigningKeySource,
	opts: LiveSendOptions = {}
): Promise<DeliveryHandle> {
	// A derived identity's write is the account's record: it queues, seals and
	// replays in the account's outbox, which keeps who signs it (sessionIdentities.ts).
	const owner = opts.signer ? sessionAccount() : ownerOf(mutations);
	if (opts.signer && derivedSigner(owner, opts.signer).userHash !== ownerOf(mutations)) {
		throw new Error('sendMutationsAndAwaitShape: the rows are not the derived signer\'s');
	}
	let discovery: DiscoveryOutcome;
	try {
		discovery = await discoverDependencies(mutations, owner, opts.excludeFromDependencies, opts.fileIds ? { fileIds: opts.fileIds } : {});
	} catch (e) {
		discovery = { kind: 'blocked', block: dependencyBlockFor(e, { kind: 'discovery', observedKeys: null }) };
	}
	const extra = { ...(opts.fileIds?.length ? { fileIds: opts.fileIds } : {}), ...(opts.signer ? { signer: opts.signer } : {}) };
	const outboxId = await enqueue(mutations, owner, discovery.kind === 'blocked'
		? { discoveryBlocked: discovery.block, sourceIntentId: opts.sourceIntentId, observeAttempt: true, ...extra }
		: { dependsOn: discovery.dependsOn, sourceIntentId: opts.sourceIntentId, observeAttempt: true, ...extra });
	// ADR §11: a write that cannot be stored fails visibly; nothing is sent.
	if (outboxId === null) throw new DurabilityError();
	await opts.onDurable?.(outboxId);

	const submission = await submitEntryToSender(owner, outboxId, replaySend(owner, signSkey), senderHooks, { targeted: opts.targeted });
	const queued = (acceptance: Promise<EntryOutcome> = awaitEntryOutcome(outboxId, owner)): DeliveryHandle => ({
		outboxId,
		phase: 'queued',
		acceptance,
		...(submission.disposition.kind === 'queued' && submission.disposition.held ? { held: submission.disposition.held } : {}),
	});
	if (submission.disposition.kind === 'queued') return queued();
	if (submission.disposition.kind === 'settled') {
		const { outcome } = submission.disposition;
		return outcome.kind === 'accepted'
			? { outboxId, phase: 'accepted', acceptance: awaitEntryOutcome(outboxId, owner) }
			: queued(Promise.resolve(outcome));
	}

	const attempt = await submission.attempt;
	switch (attempt.kind) {
		case 'accepted':
			return { outboxId, phase: 'accepted', result: attempt.result as SendResult, acceptance: awaitEntryOutcome(outboxId, owner) };
		case 'failed':
			if (attempt.error instanceof IngestError && attempt.error.approvalBlocked) {
				return { ...queued(), held: { reason: 'awaiting_approval', message: AWAITING_APPROVAL_MESSAGE } };
			}
			throw attempt.error;
		case 'fenced':
			throw new SessionFencedError(`sendMutationsAndAwaitShape: the session changed before outbox entry ${outboxId} was sent`);
		case 'settled-elsewhere':
			return attempt.outcome.kind === 'accepted'
				? { outboxId, phase: 'accepted', acceptance: awaitEntryOutcome(outboxId, owner) }
				: queued(Promise.resolve(attempt.outcome));
		case 'deferred':
			return queued();
		default: {
			const unknown: never = attempt;
			throw new Error(`sendMutationsAndAwaitShape: unknown attempt ${JSON.stringify(unknown)}`);
		}
	}
}

/**
 * How the sender sends an entry of `account`'s queue: one HTTP request per
 * attempt. A failure is recorded on the entry with its next attempt time, and
 * the outbox schedule is the only retry. A unique-key conflict is still
 * checked against the server's row (our exact signature is success).
 *
 * The request is proven by the rows' author: the account with its own key, or
 * the derived identity the entry names, its key derived from the account's
 * here. Never the account for another author: the server would refuse it, and
 * it would tie the two. The key is taken when the request is made, so a
 * locked account throws VaultLockedError before anything is sent.
 */
const replaySend = (account: string, signingKey: SigningKeySource) => async (mutations: unknown[], entry?: OutboxEntry) => {
	const author = ownerOf(mutations) || account;
	const signer = entry?.signer ? derivedSigner(account, entry.signer) : null;
	if (author !== (signer?.userHash ?? account)) {
		throw new IngestError('outbox: the rows were not written by the account or the identity of it the entry names', { permanent: true });
	}
	if (signer && entry?.relation === 'user_cards') await requireOwnerOrCard(author);
	const key = signer ? await signer.signingKey() : await resolveSigningKey(signingKey);
	try {
		return await sendMutationsWithRetry(mutations, key, {
			retries: 0,
			networkRetries: 0,
			...(signer ? { confirmApplied: derivedRowAppliedOnServer } : {}),
		});
	} finally {
		// A derived key is a copy made for this request (sessionIdentities.ts).
		if (signer) key.fill(0);
	}
};

// The backend makes the first card it takes over HTTP the device's owner
// (OwnerBootstrap): a derived identity's card waits until the device has one,
// so that no identity derived from an account ends up owning a server. A card
// the server already holds goes at once: the insert only meets it, which makes
// no one the owner, and derivedRowAppliedOnServer settles that.
// Both are asked of the server before each attempt, never remembered and never
// taken from a card cache: a node reset leaves the server with neither, while
// the tab and its caches stay as they were.
async function requireOwnerOrCard(cardHash: string): Promise<void> {
	const device = await readDeviceIdentity();
	if (device.kind !== 'identity') {
		// No answer is a fact about the connection; a server's answer is the server's.
		throw new IngestError(`the device's owner could not be read: a derived card waits for it (${device.error})`, { permanent: false, network: device.kind === 'no-answer' });
	}
	if (device.identity.adminHash || await serverHoldsCard(cardHash)) return;
	throw new IngestError('the device has no owner yet: a derived card waits for one', { permanent: false });
}

/**
 * Whether the server holds a row of `userHash`'s card now, deleted or not: any
 * row means the insert only meets it. A read that fails tells nothing, and
 * counts as no.
 */
async function serverHoldsCard(userHash: string): Promise<boolean> {
	try {
		const rows = await readShapeOnce<{ user_hash?: unknown }>('user_cards', `user_hash='${userHash}'`);
		return rows.some((r) => r.user_hash === userHash);
	} catch {
		return false;
	}
}

// A derived identity's rows are not the account's own base rows: no accepted
// snapshot is kept for them (they are never edited on top of one).
const senderHooks = {
	reconcile: (mutations: unknown[], result?: unknown, entry?: OutboxEntry) =>
		reconcileAccepted(mutations, result, entry?.signer ? { recordAcceptedSnapshot: false } : {}),
	rediscover: (entry: OutboxEntry) => rediscoverDependencies(entry),
};

let approvalSession: { userHash: string; signSkey: SigningKeySource } | null = null;

async function syncApprovalHeld(userHash: string): Promise<void> {
	if (approvalSession?.userHash !== userHash) return;
	let shapes: Set<string>;
	try {
		shapes = await approvalHeldShapes(userHash);
	} catch {
		return; // unreadable now: the gate keeps what it showed
	}
	if (approvalSession?.userHash === userHash) syncBlockedWrites(userHash, shapes);
}

async function probeHeldWrite(userHash: string, shape: string): Promise<boolean> {
	const session = approvalSession;
	if (session?.userHash !== userHash) return false;
	const candidate = await approvalProbeCandidate(userHash, shape);
	if (!candidate || approvalSession !== session) return false;
	const attempt = await sendApprovalProbe(userHash, candidate.id, replaySend(userHash, session.signSkey), senderHooks);
	if (attempt?.kind !== 'accepted') return false;
	if (approvalSession === session) wakeSender(userHash, session.signSkey);
	return true;
}

let approvalWired = false;
function wireApproval(): void {
	if (approvalWired) return;
	approvalWired = true;
	onApprovalHeldChange((userHash) => void syncApprovalHeld(userHash));
	setWriteProber(probeHeldWrite);
}

export function stopDrainLoop(): void {
	approvalSession = null;
	stopOutboxLoop();
}

function wakeSender(owner: string, signSkey: SigningKeySource, opts: { releaseNetworkBackoffs?: boolean } = {}): void {
	wireApproval();
	if (approvalSession?.userHash !== owner || approvalSession.signSkey !== signSkey) {
		approvalSession = { userHash: owner, signSkey };
	}
	void syncApprovalHeld(owner);
	void (async () => {
		if (opts.releaseNetworkBackoffs) await releaseNetworkBackoffs(owner);
		wakeAccountSender(owner, replaySend(owner, signSkey), senderHooks);
	})();
}

export function resumePendingWrites(userHash: string, signSkey: SigningKeySource): void {
	wakeSender(userHash, signSkey, { releaseNetworkBackoffs: true });
}

/**
 * Send one stored write now — the exact stored mutation, never rebuilt — by a
 * targeted run of the account's sender, without draining the rest of the
 * queue: a write whose acceptance something waits on before the session
 * starts (a bootstrap card at sign-in). Its readiness (dependencies, held
 * state, schedule) is the sender's, as for any write. A transient failure is
 * recorded on the entry and reported as `retrying`, as is a write that is not
 * ready now; a rejection quarantines it and is reported as `rejected`. In a
 * tab that does not lead the account's sending, the leader tab sends it and
 * this waits for its verdict.
 */
export async function deliverStoredWrite(outboxId: string, userHash: string, signSkey: SigningKeySource): Promise<DeliveryVerdict> {
	let submission: Awaited<ReturnType<typeof submitEntryToSender>>;
	try {
		submission = await submitEntryToSender(userHash, outboxId, replaySend(userHash, signSkey), senderHooks, { targeted: true });
	} catch {
		return awaitDeliveryVerdict(outboxId, userHash); // not readable as this account's entry now: its stored verdict decides
	}
	const { disposition } = submission;
	if (disposition.kind === 'settled') return disposition.outcome;
	if (disposition.kind === 'queued') {
		return disposition.reason === 'not-sender' ? awaitDeliveryVerdict(outboxId, userHash) : { kind: 'retrying' };
	}
	const attempt = await submission.attempt;
	switch (attempt.kind) {
		case 'accepted': return { kind: 'accepted' };
		case 'failed':
			return attempt.error instanceof IngestError && attempt.error.permanent
				? { kind: 'rejected', error: attempt.error.message }
				: { kind: 'retrying' };
		case 'fenced': throw new SessionFencedError(`deliverStoredWrite: the session changed before outbox entry ${outboxId} was sent`);
		case 'settled-elsewhere': return attempt.outcome;
		case 'deferred': return awaitDeliveryVerdict(outboxId, userHash);
		default: {
			const unknown: never = attempt;
			throw new Error(`deliverStoredWrite: unknown attempt ${JSON.stringify(unknown)}`);
		}
	}
}

export const rediscoverDependencies = async (entry: OutboxEntry): Promise<DiscoveryOutcome> => {
	const block = entry.discoveryBlocked;
	if (!block || block.observedKeys === null) {
		return { kind: 'blocked', block: dependencyBlockFor(null, { kind: block?.kind ?? 'discovery', observedKeys: null }) };
	}
	return discoverDependencies(entry.mutations, entry.userHash, [entry.id], {
		observedKeys: block.observedKeys,
		...(entry.fileIds?.length ? { fileIds: entry.fileIds } : {}),
		...(block.kind === 'admission' ? { admission: block.admission ?? { scope: '', generation: null } } : { freshnessChecked: true }),
	});
};

/**
 * Replay writes that never got a server confirmation — after login (keys just
 * became available) and on reconnect. The mutations were signed when created,
 * so they replay verbatim; only the auth challenge needs the live key.
 */
export function drainPendingWrites(userHash: string, signSkey: SigningKeySource): void {
	// The loop owns pacing from here: it drains what is due now and keeps its
	// own timer until the queue empties, so a 503 with no connectivity change
	// cannot strand the queue until the next login (ADR §5). Login, a reload,
	// a leader takeover or another tab's wake prove nothing about the server or
	// the connection: every stored retry time stands.
	wakeSender(userHash, signSkey);
}
