// Ephemeral sandbox accounts use the installed SDK's key generation and cards.
// Their keys live only in this page; no account is persisted or published.
import { generateIdentityKeys, signedUserCard } from '@buckitup/pq-client/identity';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import type { UserCardRow } from '@buckitup/pq-client/types';

export interface Identity {
	userHash: string;
	signSkey: Uint8Array;
	contactPkey: Uint8Array;
	contactSkey: Uint8Array;
	/** The signed card, as the server would hold it. */
	card: UserCardRow;
}

/** ML-DSA-87 under the identity key. */
export const signPq = (message: Uint8Array, signSkey: Uint8Array): Uint8Array => ml_dsa87.sign(message, signSkey);

export const createIdentity = (name: string): Identity => {
	const keys = generateIdentityKeys();
	const card = signedUserCard(keys, { name, ownerTimestamp: Math.floor(Date.now() / 1000) });
	keys.cryptSkey.fill(0);
	return {
		userHash: card.user_hash,
		signSkey: keys.signSkey,
		contactPkey: keys.contactPkey,
		contactSkey: keys.contactSkey,
		card,
	};
};
