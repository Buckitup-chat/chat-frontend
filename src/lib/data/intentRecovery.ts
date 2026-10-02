import { api } from '@/api/client';
import { decodeHexOrBase64 } from '@/libs/enigma';
import { sendMutationsAndAwaitShape, DurabilityError, type DeliveryHandle } from './ingest';
import { intentsOf, resolveIntent, getIntent, updateIntent, enqueueIntent, markIntentAwaitingUnlock, resumeIntentAfterUnlock, type IntentEntry } from './intents';
import { VaultLockedError, resolveSigningKey, type SigningKeySource } from './keyCustody';
import {
	currentSessionToken, sameSessionToken, findEntryBySourceIntentId, awaitEntryOutcome, heldStateOf, STATE_UNCONFIRMED_MESSAGE,
	SessionFencedError, type SessionToken,
} from './outbox';
import {
	withStorageSlotLock, signAndDispatchDurably, BaseUnavailableError,
	isReconcilableStorageConflict, MAX_CONFLICT_RECONCILE_ATTEMPTS, RECONCILE_RETRY_DELAY_MS,
	type StorageIntentPayload,
} from './storageIntent';
import type { ContentPart } from '@/lib/pq/content';

export interface SignedMutationRecord {
	type?: string;
	relation?: string;
	row?: Record<string, unknown>;
	changes?: Record<string, unknown>;
	syncMetadata?: unknown;
}
export interface ReadyRowIntent {
	kind?: 'ready-row';
	relation: string;
	row: Record<string, unknown>;
	mutationType?: string;
	purpose?: string;
}

export interface MessageIntentPayload {
	kind: 'message' | 'checkpoint';
	relation: 'dialog_messages';
	peerHash: string;
	dialogHash: string;
	messageId: string;
	ownerHash: string;
	ownerTimestamp: number;
	parts: ContentPart[];
	observedTails: Record<string, string>;
}

export interface MessageRevisionIntentPayload {
	kind: 'edit' | 'delete';
	relation: 'dialog_messages';
	peerHash: string;
	dialogHash: string;
	messageId: string;
	ownerHash: string;
	parts?: ContentPart[];
	observedTails: Record<string, string>;
}

export interface ReactionIntentPayload {
	kind: 'reaction';
	relation: 'dialog_message_reactions';
	peerHash: string;
	dialogHash: string;
	messageId: string;
	messageSignHash: string;
	emoji: string;
	desiredActive: boolean;
	ownerHash: string;
}

export interface ReceiptIntentPayload {
	kind: 'receipt';
	relation: 'dialog_message_receipts';
	peerHash: string;
	dialogHash: string;
	ownerHash: string;
	row: Record<string, unknown>;
}

export type DialogIntentPayload = MessageIntentPayload | MessageRevisionIntentPayload | ReactionIntentPayload | ReceiptIntentPayload;
export const DIALOG_INTENT_KINDS = new Set(['message', 'checkpoint', 'edit', 'delete', 'reaction', 'receipt']);

export const isUnsignedDialogIntent = (intent: unknown): intent is DialogIntentPayload => {
	const i = intent as { kind?: unknown; signingClaimToken?: unknown; signedMutation?: unknown; resolved?: unknown } | null;
	return !!i && DIALOG_INTENT_KINDS.has(String(i.kind)) && !i.signingClaimToken && !i.signedMutation && i.resolved !== true;
};

export class IntentChangedError extends Error {
	constructor(intentId: string) {
		super(`intent ${intentId} changed while it was being built — built again from what is stored`);
		this.name = 'IntentChangedError';
	}
}

export type StoredIntentPayload = ReadyRowIntent | DialogIntentPayload | StorageIntentPayload;

type OnSigned = (mutation: { changes?: Record<string, unknown> }) => void;
interface SignAndDispatchOptions {
	onSigned?: OnSigned;
	token?: SessionToken;
	onDurable?: (outboxId: string) => void | Promise<void>;
	excludeFromDependencies?: string[];
	bootstrap?: boolean;
	onLinked?: () => void;
	builtFrom?: unknown;
}
export async function withIntentSigningLock<T>(intentId: string, fn: () => Promise<T>): Promise<T> {
	return withIntentLock(intentId, () => fn());
}
const intentQueues = new Map<string, Promise<void>>();
async function withIntentLock<T>(intentId: string, fn: (locked: boolean) => Promise<T>): Promise<T> {
	const previous = intentQueues.get(intentId) ?? Promise.resolve();
	let release!: () => void;
	const done = new Promise<void>((resolve) => { release = resolve; });
	const turn = previous.then(() => done);
	intentQueues.set(intentId, turn);
	await previous;
	try {
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		if (!locks?.request) return await fn(false);
		return await locks.request(`buckitup-intent-sign:${intentId}`, () => fn(true));
	} finally {
		release();
		if (intentQueues.get(intentId) === turn) intentQueues.delete(intentId);
	}
}

function buildSignedMutation(intent: ReadyRowIntent, signSkey: Uint8Array): SignedMutationRecord {
	if (intent.relation === 'user_storage') {
		const row = intent.row as {
			user_hash: string;
			uuid: string;
			value_b64: string;
			deleted_flag?: boolean;
			owner_timestamp: number;
			parent_sign_hash: string | null;
		};
		const createStorageMutation = api.createStorageMutation as (...args: unknown[]) => SignedMutationRecord;
		return createStorageMutation(
			row.user_hash, row.uuid, row.value_b64, null, 0, row.owner_timestamp,
			signSkey, false, !!row.deleted_flag, row.parent_sign_hash ?? null, null, null,
			intent.mutationType ?? 'insert'
		);
	}
	if (intent.relation === 'user_cards') {
		const row = intent.row as {
			user_hash: string; name: string; owner_timestamp: number;
			sign_pkey: string; contact_pkey: string; contact_cert: string; crypt_pkey: string; crypt_cert: string;
		};
		const createUserCard = api.createUserCard as (...args: unknown[]) => { mutation: SignedMutationRecord };
		return createUserCard(row.name, {
			user_hash: row.user_hash,
			sign_pkey: decodeHexOrBase64(row.sign_pkey),
			contact_pkey: decodeHexOrBase64(row.contact_pkey),
			contact_cert: decodeHexOrBase64(row.contact_cert),
			crypt_pkey: decodeHexOrBase64(row.crypt_pkey),
			crypt_cert: decodeHexOrBase64(row.crypt_cert),
			sign_skey: signSkey,
		}, intent.mutationType ?? 'insert', row.owner_timestamp).mutation;
	}
	return api.createGenericMutation(intent.relation, intent.row, signSkey, intent.mutationType ?? 'insert') as SignedMutationRecord;
}

const pendingSignAndDispatch = new Map<string, Promise<DeliveryHandle>>();
const handleForOutboxId = async (outboxId: string | null, userHash: string): Promise<DeliveryHandle> => {
	if (!outboxId) {
		throw new Error(
			'signAndDispatchIntent: this intent is marked resolved but carries no durable outbox linkage — cannot positively confirm its outcome'
		);
	}
	const state = await heldStateOf(outboxId, userHash);
	const handle: DeliveryHandle = { outboxId, phase: 'queued', acceptance: awaitEntryOutcome(outboxId, userHash) };
	if (state.kind === 'held') handle.held = { reason: state.reason, message: state.message };
	if (state.kind === 'unconfirmed') handle.held = { reason: 'state_unconfirmed', message: STATE_UNCONFIRMED_MESSAGE };
	return handle;
};

export async function signAndDispatchIntent(
	intentId: string,
	intent: ReadyRowIntent,
	signSkey: Uint8Array,
	opts: SignAndDispatchOptions = {}
): Promise<DeliveryHandle> {
	const inFlight = pendingSignAndDispatch.get(intentId);
	if (inFlight) return inFlight;

	const promise = withIntentLock(intentId, (locked) => signAndDispatchIntentUnguarded(intentId, intent, signSkey, opts, locked));
	pendingSignAndDispatch.set(intentId, promise);
	try {
		return await promise;
	} finally {
		if (pendingSignAndDispatch.get(intentId) === promise) pendingSignAndDispatch.delete(intentId);
	}
}

async function signAndDispatchIntentUnguarded(
	intentId: string,
	intent: ReadyRowIntent,
	signSkey: Uint8Array,
	opts: SignAndDispatchOptions,
	locked: boolean
): Promise<DeliveryHandle> {
	let persisted: IntentEntry<Record<string, unknown>> | null;
	try {
		persisted = await getIntent<Record<string, unknown>>(intentId);
	} catch (e) {
		throw new Error(`signAndDispatchIntent: could not read intent ${intentId} — refusing to guess its outcome: ${e}`);
	}
	if (persisted === null) {
		throw new Error(`signAndDispatchIntent: intent ${intentId} not found — nothing to sign or replay`);
	}
	const userHash = persisted.userHash;
	const stored = persisted.intent as Record<string, unknown>;

	if (stored.resolved === true) {
		return handleForOutboxId((stored.ref as string | null) ?? null, userHash);
	}

	const claimed = stored.signedMutation as SignedMutationRecord | undefined;

	if (claimed && stored.dispatchConfirmed) {
		const outboxId = (stored.outboxId as string | null) ?? null;
		await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: outboxId });
		return handleForOutboxId(outboxId, userHash);
	}

	let mutation: SignedMutationRecord;
	if (claimed) {
		const existing = await findEntryBySourceIntentId(userHash, intentId);
		if (existing) {
			await updateIntent(intentId, { ...intent, signedMutation: claimed, dispatchConfirmed: true, outboxId: existing.outboxId });
			await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: existing.outboxId });
			return handleForOutboxId(existing.outboxId, userHash);
		}
		mutation = claimed;
	} else {
		if (opts.builtFrom !== undefined && JSON.stringify(stored) !== JSON.stringify(opts.builtFrom)) {
			throw new IntentChangedError(intentId);
		}
		if (!locked) {
			const claimToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
			const claimedOk = await updateIntent(intentId, { ...intent, signingClaimToken: claimToken });
			if (!claimedOk) {
				throw new Error('Could not durably claim this intent for signing.');
			}
			const verify = await getIntent<Record<string, unknown>>(intentId);
			if ((verify?.intent as Record<string, unknown> | undefined)?.signingClaimToken !== claimToken) {
				throw new Error(
					'signAndDispatchIntent: lost a concurrent claim for this intent with no cross-context lock available (§3) — never signed, the intent stays durable for the winner (or a later retry) to finish'
				);
			}
		}
		if (opts.token && !sameSessionToken(opts.token, currentSessionToken())) {
			throw new SessionFencedError(`signAndDispatchIntent: the session changed before intent ${intentId} was signed`);
		}
		mutation = buildSignedMutation(intent, signSkey);
		if (!opts.token || sameSessionToken(opts.token, currentSessionToken())) {
			opts.onSigned?.(mutation as { changes?: Record<string, unknown> });
		}
		const claimedOk = await updateIntent(intentId, { ...intent, signedMutation: mutation });
		if (!claimedOk) {
			throw new Error('Could not durably claim the signed snapshot — refusing to dispatch an unclaimed signature.');
		}
	}

	try {
		const result = await sendMutationsAndAwaitShape([mutation], signSkey, {
			targeted: opts.bootstrap,
			sourceIntentId: intentId,
			excludeFromDependencies: opts.excludeFromDependencies,
			onDurable: async (outboxId) => {
				if (opts.token && !sameSessionToken(opts.token, currentSessionToken())) {
					throw new SessionFencedError(`signAndDispatchIntent: the session changed before intent ${intentId} was linked to its outbox entry`);
				}
				await opts.onDurable?.(outboxId);
				try {
					const confirmed = await updateIntent(intentId, {
						...intent, signedMutation: mutation, dispatchConfirmed: true, outboxId,
					}).catch((e) => {
						console.warn('[intents] durable dispatch-confirmed write threw:', intentId, e);
						return false;
					});
					if (!confirmed) {
						console.warn(
							'[intents] could not durably mark dispatch as confirmed — recovery will find it via the outbox\'s own sourceIntentId link instead:',
							intentId
						);
						return;
					}
					await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: outboxId });
				} finally {
					opts.onLinked?.();
				}
			},
		});
		await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: result.outboxId });
		return result;
	} catch (e) {
		if (!(e instanceof DurabilityError)) {
			const current = await getIntent<Record<string, unknown>>(intentId).catch(() => null);
			const currentStored = current?.intent as Record<string, unknown> | undefined;
			if (currentStored?.dispatchConfirmed) {
				await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: (currentStored.outboxId as string | null) ?? null });
			} else {
				console.warn('[intents] leaving intent for the next recovery attempt — no durable dispatch-confirmed proof yet:', intentId, e);
			}
		}
		throw e;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type StorageMaterializer = (payload: StorageIntentPayload, token: SessionToken, excludeIds?: string[]) => Promise<ReadyRowIntent>;

export type StorageDispatchResult =
	| { kind: 'already-claimed' }
	| { kind: 'base-unavailable'; message: string }
	/** The account's keys are locked: nothing was built or signed; the intent waits for the unlock. */
	| { kind: 'awaiting-unlock'; message: string }
	| { kind: 'dispatched'; dispatchPromise: Promise<DeliveryHandle> };

export async function materializeSignEnqueueStorageIntent(
	userHash: string,
	uuid: string,
	intentId: string,
	signSkey: Uint8Array,
	token: SessionToken,
	materialize: StorageMaterializer,
	excludeFromDependencies: string[] = []
): Promise<StorageDispatchResult> {
	const lockResult = await withStorageSlotLock(userHash, uuid, async (): Promise<
		| { kind: 'already-claimed' }
		| { kind: 'base-unavailable'; message: string }
		| { kind: 'awaiting-unlock'; message: string }
		| { kind: 'dispatching'; payload: StorageIntentPayload; dispatchPromise: Promise<DeliveryHandle> }
	> => {
		const current = await getIntent<Record<string, unknown>>(intentId);
		if (!current || current.intent.kind !== 'storage') {
			return { kind: 'already-claimed' };
		}
		const payload = current.intent as unknown as StorageIntentPayload;

		let readyRow: ReadyRowIntent;
		try {
			readyRow = await materialize(payload, token, excludeFromDependencies);
		} catch (e) {
			if (e instanceof BaseUnavailableError) return { kind: 'base-unavailable', message: e.message };
			if (e instanceof VaultLockedError) return { kind: 'awaiting-unlock', message: e.message };
			throw e;
		}

		const { durable, dispatchPromise } = signAndDispatchDurably((onLinked) =>
			signAndDispatchIntent(intentId, readyRow, signSkey, { token, onLinked, excludeFromDependencies })
		);
		await durable;
		return { kind: 'dispatching', payload, dispatchPromise };
	});

	if (lockResult.kind !== 'dispatching') return lockResult;

	const { payload, dispatchPromise } = lockResult;
	const reconciledDispatch = dispatchPromise.catch(async (e: unknown) => {
		if (!isReconcilableStorageConflict(e)) throw e;
		const attempts = payload.conflictAttempts ?? 0;
		if (attempts >= MAX_CONFLICT_RECONCILE_ATTEMPTS) throw e;

		await sleep(RECONCILE_RETRY_DELAY_MS);
		const nextPayload: StorageIntentPayload = { ...payload, conflictAttempts: attempts + 1 };
		const nextIntentId = await enqueueIntent(nextPayload, userHash, 'user_storage');
		if (!nextIntentId) throw e;

		const superseded = await findEntryBySourceIntentId(userHash, intentId);
		const nextExclude = superseded ? [...excludeFromDependencies, superseded.outboxId] : excludeFromDependencies;

		const retryResult = await materializeSignEnqueueStorageIntent(userHash, uuid, nextIntentId, signSkey, token, materialize, nextExclude);
		if (retryResult.kind === 'dispatched') return retryResult.dispatchPromise;
		if (retryResult.kind === 'base-unavailable') throw new BaseUnavailableError(retryResult.message);
		if (retryResult.kind === 'awaiting-unlock') throw new VaultLockedError(retryResult.message);
		throw e;
	});

	return { kind: 'dispatched', dispatchPromise: reconciledDispatch };
}

const warnUndelivered = (intentId: string, e: unknown) =>
	console.warn('[intents] recovered intent is stored; its delivery is the outbox\'s now:', intentId, e);

async function handOverDurably(intentId: string, readyRow: ReadyRowIntent, signSkey: Uint8Array, token: SessionToken, builtFrom?: unknown): Promise<void> {
	const { durable, dispatchPromise } = signAndDispatchDurably((onLinked) =>
		signAndDispatchIntent(intentId, readyRow, signSkey, { token, onLinked, builtFrom })
	);
	void dispatchPromise.catch((e) => warnUndelivered(intentId, e));
	await durable;
}

export async function recoverIntents(
	userHash: string,
	signingKey: SigningKeySource,
	opts: {
		materializeMessage?: (payload: DialogIntentPayload, token: SessionToken) => Promise<ReadyRowIntent | null>;
		materializeStorage?: (payload: StorageIntentPayload, token: SessionToken) => Promise<ReadyRowIntent>;
	} = {}
): Promise<void> {
	const token = currentSessionToken();
	if (!token || token.userHash !== userHash) {
		console.warn('[intents] recovery refused — no active session bound to', userHash);
		return;
	}

	let entries: IntentEntry[];
	try {
		const scan = await intentsOf(userHash);
		entries = scan.entries;
		for (const issue of scan.issues) {
			if (issue.kind === 'corrupt') {
				console.warn('[intents] recovery found a corrupt record it could not parse — skipped, left in place, other intents still recovered:', issue.key, issue.error);
			}
		}
	} catch (e) {
		console.warn('[intents] recovery scan failed — storage itself is unreadable, nothing was recovered this pass:', e);
		return;
	}
	const awaitUnlock = async (entry: IntentEntry, e: unknown) => {
		if (!(await withIntentLock(entry.id, () => markIntentAwaitingUnlock(entry.id, userHash)))) {
			console.warn('[intents] could not record an intent as awaiting unlock; it stays as it was:', entry.id, e);
		}
	};
	for (const entry of entries) {
		if (!sameSessionToken(token, currentSessionToken())) {
			console.warn('[intents] recovery aborted mid-scan — active session changed');
			return;
		}
		try {
			let signSkey: Uint8Array;
			try {
				signSkey = await resolveSigningKey(signingKey);
			} catch (e) {
				if (e instanceof VaultLockedError) {
					await awaitUnlock(entry, e);
					continue;
				}
				throw e;
			}
			if (!sameSessionToken(token, currentSessionToken())) {
				console.warn('[intents] recovery aborted — active session changed', entry.id);
				return;
			}
			if (!(await withIntentLock(entry.id, () => resumeIntentAfterUnlock(entry.id, userHash)))) continue;

			const stored = entry.intent as StoredIntentPayload;
			if (DIALOG_INTENT_KINDS.has(String(stored.kind))) {
				if (!opts.materializeMessage) {
					console.warn('[intents] no message materializer registered, will retry later:', entry.id);
					continue;
				}
				let readyRow: ReadyRowIntent | null;
				try {
					readyRow = await opts.materializeMessage(stored as DialogIntentPayload, token);
				} catch (e) {
					if (e instanceof VaultLockedError) {
						await awaitUnlock(entry, e);
						continue;
					}
					throw e;
				}
				if (!sameSessionToken(token, currentSessionToken())) {
					console.warn('[intents] recovery aborted after materialization — active session changed', entry.id);
					return;
				}
				if (readyRow === null) {
					await resolveIntent(entry.id, { outcome: 'noop' });
					continue;
				}
				await handOverDurably(entry.id, readyRow, signSkey, token, isUnsignedDialogIntent(stored) ? stored : undefined);
			} else if (stored.kind === 'storage') {
				if (!opts.materializeStorage) {
					console.warn('[intents] no storage materializer registered, will retry later:', entry.id);
					continue;
				}
				const result = await materializeSignEnqueueStorageIntent(
					stored.userHash, stored.uuid, entry.id, signSkey, token, opts.materializeStorage
				);
				if (result.kind === 'dispatched') void result.dispatchPromise.catch((e) => warnUndelivered(entry.id, e));
				else if (result.kind === 'awaiting-unlock') await awaitUnlock(entry, result.message);
				else if (result.kind === 'base-unavailable') {
					console.warn('[intents] storage base unavailable during recovery, will retry later:', entry.id, result.message);
				}
			} else {
				await handOverDurably(entry.id, stored as ReadyRowIntent, signSkey, token);
			}
		} catch (e) {
			console.warn('[intents] recovery failed for one intent, will retry later:', entry.id, e);
		}
	}
}
