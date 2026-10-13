// A guardian's own slot in a backup version, found with their viewing key
// (chain.guardianChainReads, guardianInvite.slotIsMine), and the stealth key
// that signs their approval (chat repo: pq_recovery_shares § Returning;
// ERC-5564 scheme 1 as the SDK implements it). The slot is never stored or
// sent: the owner derived it for this version from the meta-address the
// guardian accepted with, and only the guardian's keys recognise it.
import { computeStealthKey } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { ChainUnavailableError, guardianChainReads, type SlotReader } from './chain';
import type { MetaKeys } from './guardianInvite';

export type { SlotReader };

export interface MySlot {
	stealthAddress: string;
	/** The stealth address's private key: what signs initiate and approve for this guardian. */
	privateKey: string;
}

/** The slot of `version` addressed to these keys, or null when none is: not, or no longer, a guardian. */
export const findMySlot = async (chain: SlotReader, id: string, version: number, keys: MetaKeys): Promise<MySlot | null> => {
	const reads = guardianChainReads(
		{
			...chain,
			readSecret: async () => {
				throw new ChainUnavailableError('finding a slot reads no secret');
			},
		},
		async () => keys,
	);
	const slot = await reads.mySlot(id, version);
	if (!slot) return null;
	return {
		stealthAddress: slot.stealthAddress,
		privateKey: computeStealthKey({ spendingPrivateKey: keys.spendingPrivateKey, viewingPrivateKey: keys.viewingPrivateKey }, slot.ephemeralPubKey),
	};
};
