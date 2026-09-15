// §3.6: recovery for durable intents that never reached signing before this
// session ended — vault locked mid-write, a crash, a reload. Built on top of
// intents.ts (storage) the same way ingest.ts is built on top of outbox.ts:
// this module owns the sign+dispatch+resolve step, so dialogs.store.js's
// pushRow (a fresh write) and recoverIntents (a resumed one) share one path
// instead of two that could drift apart.
//
// The recovered write replays the row exactly as captured at intent
// creation — the causal scope (refs_map_b64, parent_sign_hash, etc.) it
// carries is never re-derived against whatever state is current by the time
// the vault unlocks (main-tanstack-proposal-v3.md, "Момент signing": a
// captured scope is fixed at creation, not silently replaced by fresher
// tails later).
import { api } from '@/api/client';
import { sendMutationsAndAwaitShape, DurabilityError } from './ingest';
import { intentsOf, resolveIntent, type IntentEntry } from './intents';

export interface StoredIntent {
	relation: string;
	row: Record<string, unknown>;
	mutationType?: string;
}

/**
 * Sign and dispatch one durable intent — the same path a fresh pushRow call
 * uses. Resolves the intent once the signed mutation is durable in
 * outbox.ts; a DurabilityError (nothing durable happened) leaves it for a
 * later attempt, anything else means outbox.ts now owns it (§3.1's rule).
 */
export async function signAndDispatchIntent(
	intentId: string,
	intent: StoredIntent,
	signSkey: Uint8Array
): Promise<unknown> {
	const mutation = api.createGenericMutation(intent.relation, intent.row, signSkey, intent.mutationType ?? 'insert');
	try {
		const result = await sendMutationsAndAwaitShape([mutation], signSkey);
		await resolveIntent(intentId);
		return result;
	} catch (e) {
		if (!(e instanceof DurabilityError)) await resolveIntent(intentId);
		throw e;
	}
}

/**
 * Resume every durable intent left over from before this session, for one
 * account. Called once the vault is unlocked (login), alongside outbox.ts's
 * own drainPendingWrites — the two lifecycle levels (unsigned intent, signed
 * snapshot) recover independently, each through its own path.
 *
 * One intent's failure must not stop the rest: an unrelated intent (a
 * different message, a different slot) is not this one's dependent.
 */
export async function recoverIntents(userHash: string, signSkey: Uint8Array): Promise<void> {
	let entries: IntentEntry[];
	try {
		entries = await intentsOf(userHash);
	} catch (e) {
		console.warn('[intents] recovery scan failed:', e);
		return;
	}
	for (const entry of entries) {
		try {
			await signAndDispatchIntent(entry.id, entry.intent as StoredIntent, signSkey);
		} catch (e) {
			// Transient/permanent: outbox.ts already recorded it (or, for a
			// DurabilityError, the intent stays for the next recovery pass).
			// Either way, one bad intent must not stop the rest.
			console.warn('[intents] recovery failed for one intent, will retry later:', entry.id, e);
		}
	}
}
