// Publishing the card of an identity derived from the account: the notes
// identity, or the peer of a note (pq_notes_to_self.proposed.md).
//
// A derived identity needs its card on the server before anything of it can
// be verified: its dialog rows name it, and the dialog_keys foreign key needs
// it. The card goes out through the account's outbox, proven by the derived
// identity itself (sessionIdentities.ts), and only when no valid card exists
// and none is queued yet: every device derives the same identity, and the
// first card stands.
// The sender holds it back from a device without an owner (ingest.ts).
import { getVerifiedSignPkey } from '@/lib/data/cardRegistry';
import { sendMutationsAndAwaitShape, type DeliveryHandle } from '@/lib/data/ingest';
import type { SigningKeySource } from '@/lib/data/keyCustody';
import { pendingEntries } from '@/lib/data/outbox';
import { sameSigner, sessionAccount, type DerivedSigner } from '@/lib/data/sessionIdentities';
import { nextOwnerTimestamp } from '@/lib/data/time';
import type { UserCardRow } from '@/lib/data/types';

export interface DerivedCard {
	userHash: string;
	row: (ownerTimestamp: number) => UserCardRow;
}

/**
 * Makes sure `signer`'s card (EncryptionManagerPQ.derivedCard) is published:
 * - 'present': a valid one is already there;
 * - 'queued': one is already in the account's outbox;
 * - otherwise the delivery of a fresh one.
 * `accountKey` is the account's signing key source, which the outbox needs to
 * run; the request itself is proven by the derived identity.
 */
export async function ensureDerivedCard(
	signer: DerivedSigner,
	card: DerivedCard,
	accountKey: SigningKeySource,
	verifiedCard: (userHash: string) => Promise<string | null> = getVerifiedSignPkey,
): Promise<'present' | 'queued' | DeliveryHandle> {
	if (await verifiedCard(card.userHash)) return 'present';
	const queued = (await pendingEntries(sessionAccount())).some((e) => e.relation === 'user_cards' && !!e.signer && sameSigner(e.signer, signer));
	if (queued) return 'queued';
	const modified = card.row(nextOwnerTimestamp());
	return sendMutationsAndAwaitShape([{ type: 'insert', syncMetadata: { relation: 'user_cards' }, modified }], accountKey, { signer });
}
