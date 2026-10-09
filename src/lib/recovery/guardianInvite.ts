// Asking a contact to be a guardian, and the keys they answer with (chat repo:
// pq_recovery_shares § Inviting). The owner needs the guardian's stealth
// meta-address to derive their slot; it travels in the dialog, inside a reply
// that proves the replier holds its keys.
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { CURVE } from '@noble/secp256k1';
import { SigningKey } from 'ethers';
import { hkdfDerive } from '@/lib/pq/hkdf';
import { personalSign, personalSigner } from './evmSign';

const META_SALT = 'buckitup/stealth-meta/v1';
const INVITE_ID = /^[0-9a-f]{32}$/;
const META_ADDRESS = /^0x[0-9a-f]{132}$/;

export interface MetaKeys {
	spendingPrivateKey: string;
	viewingPrivateKey: string;
	/** `0x` + compressed spending key + compressed viewing key, lowercase: 66 bytes. */
	metaAddress: string;
}

/** The 32-byte seed a guardian's client keeps in the account vault, made at its first acceptance. */
export const newMetaSeed = (): Uint8Array => randomBytes(32);

const scalarOf = (seed: Uint8Array, info: 'spend' | 'view'): string => {
	const k = BigInt('0x' + bytesToHex(hkdfDerive(seed, META_SALT, info, 32))) % CURVE.n;
	// A zero scalar is a 2^-256 event; failing beats a key that is no key.
	if (k === 0n) throw new Error('meta seed gives a zero key');
	return '0x' + k.toString(16).padStart(64, '0');
};

/**
 * The stealth meta keys from the seed and nothing else — no PIN, no device
 * secret, not the account's EVM key — so a restored account or a linked device
 * derives the same ones (§ Inviting, "The keys").
 */
export const metaKeysOf = (seed: Uint8Array): MetaKeys => {
	if (seed.length !== 32) throw new Error('a meta seed is 32 bytes');
	const spendingPrivateKey = scalarOf(seed, 'spend');
	const viewingPrivateKey = scalarOf(seed, 'view');
	const compressed = (k: string) => new SigningKey(k).compressedPublicKey.slice(2);
	return {
		spendingPrivateKey,
		viewingPrivateKey,
		metaAddress: ('0x' + compressed(spendingPrivateKey) + compressed(viewingPrivateKey)).toLowerCase(),
	};
};

/** The spending key's compressed public key, or null unless both halves are points on the curve. */
export const spendingKeyOf = (metaAddress: string): string | null => {
	if (!META_ADDRESS.test(metaAddress)) return null;
	const spend = '0x' + metaAddress.slice(2, 68);
	const view = '0x' + metaAddress.slice(68);
	try {
		SigningKey.computePublicKey(spend);
		SigningKey.computePublicKey(view);
	} catch {
		return null;
	}
	return spend;
};

export const newInviteId = (): string => bytesToHex(randomBytes(16));

const proofMessage = (inviteId: string, ownerUserHash: string, guardianUserHash: string) =>
	`buckitup/recovery-invite/v1\n${inviteId}\n${ownerUserHash}\n${guardianUserHash}`;

/** The acceptance proof: the spending key signs the invitation and both identities. */
export const inviteProof = (keys: MetaKeys, inviteId: string, ownerUserHash: string, guardianUserHash: string): string =>
	personalSign(keys.spendingPrivateKey, proofMessage(inviteId, ownerUserHash, guardianUserHash));

export interface InviteReply {
	inviteId: string;
	answer: string;
	metaAddress: string;
	proofB64: string;
}

export type CheckedReply =
	| { ok: true; answer: 'accept'; metaAddress: string }
	| { ok: true; answer: 'decline' }
	| { ok: false; reason: string };

/**
 * A reply as the owner's client judges it (§ Inviting, step 4). One that fails
 * is ignored and reported: it neither accepts nor withdraws. Whether
 * `inviteId` is the live invitation to this dialog peer is the roster's to say.
 */
export const checkInviteReply = (reply: InviteReply, ownerUserHash: string, guardianUserHash: string): CheckedReply => {
	if (!INVITE_ID.test(reply.inviteId)) return { ok: false, reason: 'not an invitation id' };
	if (reply.answer === 'decline') return { ok: true, answer: 'decline' };
	if (reply.answer !== 'accept') return { ok: false, reason: `unknown answer ${JSON.stringify(reply.answer)}` };
	const spend = spendingKeyOf(reply.metaAddress);
	if (!spend) return { ok: false, reason: 'the meta-address is not two curve points' };
	const signer = personalSigner(proofMessage(reply.inviteId, ownerUserHash, guardianUserHash), reply.proofB64);
	if (!signer || signer.publicKey !== spend) return { ok: false, reason: 'the proof is not by the meta-address\'s spending key' };
	return { ok: true, answer: 'accept', metaAddress: reply.metaAddress };
};

export type InviteState = { state: 'pending' } | { state: 'accepted'; metaAddress: string } | { state: 'declined' } | { state: 'void' };

/**
 * An invitation's state from the set of its valid replies, in any order, so
 * two devices that see them differently agree: a decline at any time
 * withdraws it, and two acceptances that differ void it.
 */
export const inviteStateOf = (replies: CheckedReply[]): InviteState => {
	if (replies.some((r) => r.ok && r.answer === 'decline')) return { state: 'declined' };
	const metas = new Set(replies.flatMap((r) => (r.ok && r.answer === 'accept' ? [r.metaAddress] : [])));
	if (metas.size === 0) return { state: 'pending' };
	if (metas.size > 1) return { state: 'void' };
	return { state: 'accepted', metaAddress: [...metas][0] };
};
