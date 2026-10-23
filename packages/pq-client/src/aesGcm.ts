// AES-256-GCM as every sealed value of the protocol lays it out:
// nonce(12) || ciphertext || tag(16). File chunks, message content and
// wrapped message keys use it.
import { randomBytes } from '@noble/hashes/utils';

const importKey = (key: Uint8Array) =>
	crypto.subtle.importKey('raw', key as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** nonce(12) || AES-256-GCM(key, plain), under a fresh random nonce. */
export const sealAesGcm = async (key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> => {
	const nonce = randomBytes(12);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await importKey(key), plain as unknown as ArrayBuffer),
	);
	const out = new Uint8Array(12 + ct.length);
	out.set(nonce, 0);
	out.set(ct, 12);
	return out;
};

/** The plaintext of a sealed value; throws if it is too short, under another key, or altered. */
export const openAesGcm = async (key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> => {
	if (sealed.length < 12 + 16) throw new Error('sealed value too short to hold nonce and tag');
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: sealed.subarray(0, 12) },
			await importKey(key),
			sealed.subarray(12) as unknown as ArrayBuffer,
		),
	);
};
