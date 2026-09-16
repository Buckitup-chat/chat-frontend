import { api } from '@/api/client';
import { sendMutationsAndAwaitShape, DurabilityError } from './ingest';
import { intentsOf, resolveIntent, type IntentEntry } from './intents';

export interface StoredIntent {
	relation: string;
	row: Record<string, unknown>;
	mutationType?: string;
}

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
			console.warn('[intents] recovery failed for one intent, will retry later:', entry.id, e);
		}
	}
}
