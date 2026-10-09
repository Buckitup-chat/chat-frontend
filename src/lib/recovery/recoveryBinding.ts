// The link between an on-chain candidate and a chat identity during a
// recovery (chat repo: pq_recovery_shares § Returning, step 3): the temporary
// account proves it holds the candidate key, and both screens show ten words
// that the owner reads out and the guardian compares.
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { wordlists } from 'ethers';
import { personalSign, personalSigner } from './evmSign';

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** `eip155:<chainId>:<contract>/<id>` in its canonical form: decimal chain id, lowercase hex (07 § recovery_share). */
const SECRET_REF = /^eip155:[1-9][0-9]*:0x[0-9a-f]{40}\/0x[0-9a-f]{64}$/;
const USER_HASH = /^u_[0-9a-f]{128}$/;

/** The candidate in the one form both sides hash: lowercase hex. Throws on anything else. */
export const canonicalCandidate = (candidate: string): string => {
	const c = candidate.toLowerCase();
	if (!ADDRESS.test(c)) throw new Error(`not an address: ${candidate}`);
	return c;
};

/**
 * The strings the binding and the words hash, held to their canonical forms:
 * two builds must hash the same bytes, and a string with two spellings would
 * hash two ways.
 */
const checkRefs = (secretRef: string, userHash: string): void => {
	if (!SECRET_REF.test(secretRef)) throw new Error(`not a canonical secret_ref: ${secretRef}`);
	if (!USER_HASH.test(userHash)) throw new Error(`not a user_hash: ${userHash}`);
};

const bindingMessage = (secretRef: string, userHash: string) => {
	checkRefs(secretRef, userHash);
	return `buckitup/recovery-binding/v1\n${secretRef}\n${userHash}`;
};

/** The binding's signature by the candidate key, over the secret and the sender's own user_hash. */
export const signBinding = (candidatePrivateKey: string, secretRef: string, userHash: string): string =>
	personalSign(candidatePrivateKey, bindingMessage(secretRef, userHash));

/**
 * The candidate, canonical, once the binding answers the guardian's own
 * request — the secret_ref they sent — comes from the dialog peer, and is
 * signed by the candidate it names. Throws otherwise. What says the peer is
 * the person on the call is the ten-word code, not this.
 */
export const checkBinding = (
	binding: { secretRef: string; candidate: string; userHash: string; signatureB64: string },
	expected: { secretRef: string; dialogPeerUserHash: string },
): string => {
	if (binding.secretRef !== expected.secretRef) throw new Error('the binding is for another secret than the one asked about');
	if (binding.userHash !== expected.dialogPeerUserHash) throw new Error('the binding names another account than the one sending it');
	const candidate = canonicalCandidate(binding.candidate);
	const signer = personalSigner(bindingMessage(binding.secretRef, binding.userHash), binding.signatureB64);
	if (!signer || signer.address !== candidate) throw new Error('the binding is not signed by the candidate it names');
	return candidate;
};

/**
 * Ten BIP-39 English words: the first 110 bits of
 * `SHA3-256("buckitup/recovery-code/v1\n" || secret_ref || "\n" || candidate || "\n" || user_hash)`,
 * big-endian, as ten 11-bit indices, with the candidate as lowercase hex. 110
 * bits cannot be ground into a collision by minting candidate keys, and the
 * code is spoken, so it is words.
 */
export const recoveryWords = (secretRef: string, candidate: string, userHash: string): string[] => {
	checkRefs(secretRef, userHash);
	const digest = sha3_256(new TextEncoder().encode(`buckitup/recovery-code/v1\n${secretRef}\n${canonicalCandidate(candidate)}\n${userHash}`));
	const bits = BigInt('0x' + bytesToHex(digest));
	return Array.from({ length: 10 }, (_, i) => wordlists.en.getWord(Number((bits >> BigInt(256 - 11 * (i + 1))) & 0x7ffn)));
};
