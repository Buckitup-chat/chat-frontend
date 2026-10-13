// The way back by hand (chat repo: pq_recovery_shares § Manual return): when
// the dialog cannot carry it, a guardian and the person recovering finish on a
// call or in another messenger, with text. The same three things cross as in
// the dialog — secret_ref, the binding, the share — and what the dialog gave
// for free is rebuilt: the share is sealed to the temporary account's KEM key,
// and six digits read out over the call say that the block pasted is the one
// the guardian made. The recovering app imports nothing until they match.
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { hkdfDerive } from '@/lib/pq/hkdf';
import { sixDigitCode } from '@/lib/pq/deviceLink';
import { assertSealed, openSealed, sealWithKey, VaultEnvelopeError } from '@/lib/pq/vaultEnvelope';
import { decodeContent, encodeContent, type RecoveryBindingPart, type RecoveryShareReturnPart } from '@/lib/pq/content';
import { fromBase64, toBase64, toBytes } from '@/lib/pq/signature';

export const RECOVERY_RETURN_SALT = 'buckitup/recovery-return/v1';
const BLOCK_TAG = 'BUCKITUP-SHARE';
const BINDING_TAG = 'BUCKITUP-BINDING';
const USER_HASH = /^u_[0-9a-f]{128}$/;
/** An ML-KEM-1024 ciphertext. */
const KEM_CT_BYTES = 1568;

export class ManualReturnError extends Error {}

const utf8 = (s: string) => new TextEncoder().encode(s);
/** Messengers wrap long lines and add spaces; none of the characters used here is whitespace. */
const compact = (text: string) => text.replace(/\s+/g, '');

/** The seal key and the six digits, both from the KEM's shared secret and the secret the share belongs to. */
const derive = (sharedSecret: Uint8Array, secretRef: string) => ({
	key: hkdfDerive(sharedSecret, RECOVERY_RETURN_SALT, `seal|${secretRef}`, 32),
	digits: sixDigitCode(sharedSecret, RECOVERY_RETURN_SALT, `sas|${secretRef}`),
});

/* ------------------------------- the binding ------------------------------- */

/** The binding as text: `BUCKITUP-BINDING.<secret_ref>.<candidate>.<user_hash>.<signature_b64>`, its fields in the envelope's order. */
export const bindingText = (b: Pick<RecoveryBindingPart, 'secretRef' | 'candidate' | 'userHash' | 'signatureB64'>): string =>
	[BINDING_TAG, b.secretRef, b.candidate, b.userHash, b.signatureB64].join('.');

/** A binding pasted by hand, as a `recovery_binding` part; throws ManualReturnError for anything else. checkBinding judges it. */
export const parseBindingText = (text: string): RecoveryBindingPart => {
	const parts = compact(text).split('.');
	if (parts.length !== 5 || parts[0] !== BINDING_TAG) throw new ManualReturnError('This is not the code their app shows to be sent back.');
	const [, secretRef, candidate, userHash, signatureB64] = parts;
	return { kind: 'recovery_binding', secretRef, candidate, userHash, signatureB64 };
};

/* -------------------------------- the block -------------------------------- */

/**
 * The guardian's side: the return sealed to the temporary account's
 * `crypt_pkey` (from its verified card) and signed by the guardian, as the
 * one line to send, with the digits to read out. `sign` is the guardian's
 * ML-DSA signature over the bytes it is given.
 */
export const sealReturnBlock = async (opts: {
	cryptPkey: string | Uint8Array;
	part: RecoveryShareReturnPart;
	guardianUserHash: string;
	sign: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}): Promise<{ block: string; digits: string }> => {
	if (!USER_HASH.test(opts.guardianUserHash)) throw new ManualReturnError('not a user_hash');
	const { cipherText, sharedSecret } = ml_kem1024.encapsulate(toBytes(opts.cryptPkey));
	const { key, digits } = derive(sharedSecret, opts.part.secretRef);
	sharedSecret.fill(0);
	// The envelope the dialog would carry, verbatim.
	const sealed = await sealWithKey(key, encodeContent([opts.part]));
	key.fill(0);
	const signed = [BLOCK_TAG, toBase64(cipherText), sealed, opts.guardianUserHash].join('.');
	const signature = await opts.sign(utf8(signed));
	return { block: `${signed}.${toBase64(signature)}`, digits };
};

export interface ReturnBlock {
	kemCipherText: Uint8Array;
	sealed: string;
	/** The user_hash the block names as its guardian; the signature is checked against their card, when there is one. */
	guardian: string;
	signature: Uint8Array;
	/** The bytes the signature covers: the block up to the guardian's user_hash. */
	signed: string;
}

/** A block pasted by hand; throws ManualReturnError unless it has the block's shape. Nothing is opened. */
export const parseReturnBlock = (text: string): ReturnBlock => {
	const parts = compact(text).split('.');
	if (parts.length !== 5 || parts[0] !== BLOCK_TAG) throw new ManualReturnError('This is not a piece sent as text.');
	const [, kem, sealed, guardian, sig] = parts;
	if (!USER_HASH.test(guardian)) throw new ManualReturnError('The piece names no guardian.');
	let kemCipherText: Uint8Array;
	let signature: Uint8Array;
	try {
		kemCipherText = fromBase64(kem);
		signature = fromBase64(sig);
		assertSealed(sealed);
	} catch {
		throw new ManualReturnError('The piece is damaged: part of it is missing or was changed on the way.');
	}
	if (kemCipherText.length !== KEM_CT_BYTES) throw new ManualReturnError('The piece is damaged: part of it is missing or was changed on the way.');
	return { kemCipherText, sealed, guardian, signature, signed: parts.slice(0, 4).join('.') };
};

/** Whether the block is signed by the account whose ML-DSA public key is `signPkey`. */
export const blockSignedBy = (block: ReturnBlock, signPkey: string | Uint8Array): boolean => {
	try {
		return ml_dsa87.verify(block.signature, utf8(block.signed), toBytes(signPkey));
	} catch {
		return false;
	}
};

export interface ReadBlock {
	guardian: string;
	/** What this device derives; the guardian reads theirs out, and the person says whether they match. */
	digits: string;
	/** The return inside — only once the person confirmed the digits match. Throws ManualReturnError if it does not open. */
	open: () => Promise<RecoveryShareReturnPart>;
	/** Wipes the key; `open` fails after it. */
	forget: () => void;
}

/**
 * The recovering side: decapsulates with the temporary account's key and
 * derives the digits for `secretRef` (the one this recovery is for). The
 * share stays sealed until `open` is called, which the screen does only after
 * the person says the digits match: a block a relay substituted was
 * encapsulated by someone else and gives other digits.
 */
export const readReturnBlock = async (
	block: ReturnBlock,
	secretRef: string,
	decapsulate: (cipherText: Uint8Array) => Promise<Uint8Array> | Uint8Array,
): Promise<ReadBlock> => {
	const sharedSecret = await decapsulate(block.kemCipherText);
	const { key, digits } = derive(sharedSecret, secretRef);
	sharedSecret.fill(0);
	let forgotten = false;
	return {
		guardian: block.guardian,
		digits,
		open: async () => {
			if (forgotten) throw new ManualReturnError('This piece was put aside.');
			let text: string;
			try {
				text = await openSealed(key, assertSealed(block.sealed));
			} catch (e) {
				if (e instanceof VaultEnvelopeError) throw new ManualReturnError('The piece does not open on this device: it was made for another one.');
				throw e;
			}
			let returned: RecoveryShareReturnPart | undefined;
			try {
				returned = decodeContent(text).find((p): p is RecoveryShareReturnPart => p.kind === 'recovery_share_return');
			} catch {
				returned = undefined;
			}
			if (!returned) throw new ManualReturnError('The piece opened, but there is no backup piece inside.');
			return returned;
		},
		forget: () => {
			forgotten = true;
			key.fill(0);
		},
	};
};
