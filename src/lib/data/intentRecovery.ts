import { api } from '@/api/client';
import { sendMutationsAndAwaitShape, DurabilityError, type DeliveryHandle } from './ingest';
import { intentsOf, resolveIntent, getIntent, updateIntent, type IntentEntry } from './intents';
import { currentSessionToken, sameSessionToken, findEntryBySourceIntentId, awaitEntryOutcome, type SessionToken } from './outbox';
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

export type StoredIntentPayload = ReadyRowIntent | MessageIntentPayload;

type OnSigned = (mutation: { changes?: Record<string, unknown> }) => void;
async function withIntentLock<T>(intentId: string, fn: (locked: boolean) => Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks?.request) return fn(false);
	return locks.request(`buckitup-intent-sign:${intentId}`, () => fn(true));
}

const pendingSignAndDispatch = new Map<string, Promise<DeliveryHandle>>();
const handleForOutboxId = (outboxId: string | null, userHash: string): DeliveryHandle => {
	if (!outboxId) {
		throw new Error(
			'signAndDispatchIntent: this intent is marked resolved but carries no durable outbox linkage — cannot positively confirm its outcome'
		);
	}
	return {
		outboxId,
		phase: 'queued',
		acceptance: awaitEntryOutcome(outboxId, userHash),
	};
};

export async function signAndDispatchIntent(
	intentId: string,
	intent: ReadyRowIntent,
	signSkey: Uint8Array,
	opts: {
		onSigned?: OnSigned;
		token?: SessionToken;
	} = {}
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
	opts: { onSigned?: OnSigned; token?: SessionToken },
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
		mutation = api.createGenericMutation(intent.relation, intent.row, signSkey, intent.mutationType ?? 'insert');
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
			sourceIntentId: intentId,
			onDurable: async (outboxId) => {
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

export async function recoverIntents(
	userHash: string,
	signSkey: Uint8Array,
	opts: {
		materializeMessage?: (payload: MessageIntentPayload, token: SessionToken) => Promise<ReadyRowIntent>;
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
	for (const entry of entries) {
		if (!sameSessionToken(token, currentSessionToken())) {
			console.warn('[intents] recovery aborted mid-scan — active session changed');
			return;
		}
		try {
			const stored = entry.intent as StoredIntentPayload;
			if (stored.kind === 'message' || stored.kind === 'checkpoint') {
				if (!opts.materializeMessage) {
					console.warn('[intents] no message materializer registered, will retry later:', entry.id);
					continue;
				}
				const readyRow = await opts.materializeMessage(stored, token);
				if (!sameSessionToken(token, currentSessionToken())) {
					console.warn('[intents] recovery aborted after materialization — active session changed', entry.id);
					return;
				}
				await signAndDispatchIntent(entry.id, readyRow, signSkey, { token });
			} else {
				await signAndDispatchIntent(entry.id, stored as ReadyRowIntent, signSkey);
			}
		} catch (e) {
			console.warn('[intents] recovery failed for one intent, will retry later:', entry.id, e);
		}
	}
}
