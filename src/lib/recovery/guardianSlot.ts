// A guardian's own slot in a backup version, found with their viewing key
// (guardianInvite.slotIsMine), and the stealth key that signs their approval
// (chat repo: pq_recovery_shares § Returning; ERC-5564 scheme 1 as the SDK
// implements it). The slot is never stored or sent: the owner derived it for
// this version from the meta-address the guardian accepted with, and only the
// guardian's keys recognise it.
import { computeStealthKey } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { slotIsMine, type MetaKeys } from './guardianInvite';

export interface SlotReader {
	guardiansAt: (id: string, version: bigint) => Promise<string[]>;
	shareAt: (id: string, version: bigint, stealthAddress: string) => Promise<{ ephemeralPubKey: string }>;
}

export interface MySlot {
	stealthAddress: string;
	/** The stealth address's private key: what signs initiate and approve for this guardian. */
	privateKey: string;
}

/** The slot of `version` addressed to these keys, or null when none is: not, or no longer, a guardian. */
export const findMySlot = async (chain: SlotReader, id: string, version: number, keys: MetaKeys): Promise<MySlot | null> => {
	const addresses = await chain.guardiansAt(id, BigInt(version));
	const slots = await Promise.all(addresses.map(async (a) => ({ a, eph: (await chain.shareAt(id, BigInt(version), a)).ephemeralPubKey })));
	const mine = slots.find(({ a, eph }) => slotIsMine(keys, a, eph));
	if (!mine) return null;
	return {
		stealthAddress: mine.a,
		privateKey: computeStealthKey({ spendingPrivateKey: keys.spendingPrivateKey, viewingPrivateKey: keys.viewingPrivateKey }, mine.eph),
	};
};
