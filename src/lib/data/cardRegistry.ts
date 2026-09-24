// Registry of verified author identities.
//
// resolveSignPkey for the dialog gate: reads user_cards from the replicated
// collection, runs the full trust bootstrap (lib/pq/verifyCard), and caches
// what passed. A verified card is valid for every observer — user_hash IS the
// key's digest, so the binding cannot differ per account — which makes the
// positive cache global and account-switch-safe. Failures are never cached:
// an absent or not-yet-replicated card may arrive on the next sync tick.

import { verifyUserCard } from '@/lib/pq/verifyCard';
import { getUserCardsCollection } from './collections';
import { isTouched } from './readCache';
import { readCachedCard } from './userCardsCache';
import { settled } from './shapeLink';
import type { UserCardRow } from './types';

const verified = new Map<string, string>(); // user_hash -> signPkeyB64 (padded)
const rejected = new Map<string, string>(); // user_hash -> last invalid reason (diagnostics only)

export const getVerifiedSignPkey = async (userHash: string): Promise<string | null> => {
	const hit = verified.get(userHash);
	if (hit) return hit;

	const coll = getUserCardsCollection();
	await settled(coll as unknown as Parameters<typeof settled>[0]);
	let liveRow: UserCardRow | undefined;
	try {
		liveRow = coll.get(userHash) as UserCardRow | undefined;
	} catch {
		liveRow = undefined;
	}
	const cachedRow = liveRow || isTouched('user_cards', userHash) ? null : await readCachedCard(userHash);
	const row = liveRow ?? cachedRow ?? undefined;
	if (!row) return null;

	const verdict = verifyUserCard(row);
	if (verdict.status !== 'verified') {
		// Loud on purpose: an unverifiable card silently parks every message
		// from that author in the gate, which surfaces to the user as
		// "waiting for earlier messages" with no hint of the real cause.
		if (rejected.get(userHash) !== verdict.reason) {
			console.warn('[cards] rejected', userHash.slice(0, 12), '—', verdict.reason);
		}
		// Remembered for diagnostics, not as a verdict — a valid re-signed
		// card (e.g. after a rename) must get a fresh check.
		rejected.set(userHash, verdict.reason);
		return null;
	}
	rejected.delete(userHash);
	verified.set(userHash, verdict.card.signPkeyB64);
	return verdict.card.signPkeyB64;
};

export const getCardRejection = (userHash: string): string | null => rejected.get(userHash) ?? null;

/** Test seam; the positive cache is safe to keep across accounts. */
export const resetCardRegistry = () => {
	verified.clear();
	rejected.clear();
};
