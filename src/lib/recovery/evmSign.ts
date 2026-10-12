// EIP-191 personal signatures, the one shape every recovery proof on the
// secp256k1 side takes: a stealth meta-key proving it accepted an invitation,
// a candidate key binding itself to a chat identity. The bytes are a wallet's
// `personal_sign`, so any EVM tool can check them.
import { SigningKey, computeAddress, hashMessage } from 'ethers';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { fromBase64, toBase64 } from '@/lib/pq/signature';

const unpadded = (b64: string) => b64.replace(/=+$/, '');

/** The 65-byte `r || s || v` signature, `0x` hex, as an EVM wallet and the nodes take it. */
export const personalSignHex = (privateKeyHex: string, message: string): string => new SigningKey(privateKeyHex).sign(hashMessage(message)).serialized;

/** The 65-byte `r || s || v` signature, unpadded base64. */
export const personalSign = (privateKeyHex: string, message: string): string =>
	unpadded(toBase64(hexToBytes(personalSignHex(privateKeyHex, message).slice(2))));

/**
 * Who signed `message`: the compressed public key and the address, or null
 * when the signature is not 65 bytes or recovers no key.
 */
export const personalSigner = (message: string, signatureB64: string): { publicKey: string; address: string } | null => {
	try {
		const bytes = fromBase64(signatureB64);
		if (bytes.length !== 65) return null;
		const uncompressed = SigningKey.recoverPublicKey(hashMessage(message), '0x' + bytesToHex(bytes));
		return {
			publicKey: SigningKey.computePublicKey(uncompressed, true).toLowerCase(),
			address: computeAddress(uncompressed).toLowerCase(),
		};
	} catch {
		return null;
	}
};
