import { describe, it, expect } from 'vitest';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { makeKey } from './dialogCrypto.fixtures';

describe('DialogCrypto.wrapSenderMsgKey / unwrapSenderMsgKey', () => {
	// ml_kem1024.keygen() is randomized per run — there is no golden vector here.
	const { publicKey, secretKey } = ml_kem1024.keygen();
	const senderMsgKey = makeKey(7);

	it('round-trips the sender message key through wrap then unwrap', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);
		const unwrapped = await DialogCrypto.unwrapSenderMsgKey(secretKey, wrapped.peerKemWrapKeyB64, wrapped.peerWrappedMsgKeyB64);

		expect(unwrapped).toEqual(senderMsgKey);
	});

	it('returns an object with exactly the peerKemWrapKeyB64/peerWrappedMsgKeyB64 string fields, base64-encoded', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);

		expect(Object.keys(wrapped).sort()).toEqual(['peerKemWrapKeyB64', 'peerWrappedMsgKeyB64']);
		expect(typeof wrapped.peerKemWrapKeyB64).toBe('string');
		expect(typeof wrapped.peerWrappedMsgKeyB64).toBe('string');
		expect(wrapped.peerKemWrapKeyB64).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(wrapped.peerWrappedMsgKeyB64).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it('sizes peerKemWrapKeyB64 as the raw ML-KEM-1024 ciphertext and peerWrappedMsgKeyB64 as a 12-byte nonce + senderMsgKey + 16-byte GCM tag', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);

		const kemCiphertextLength = Buffer.from(wrapped.peerKemWrapKeyB64, 'base64').length;
		const wrappedMsgKeyLength = Buffer.from(wrapped.peerWrappedMsgKeyB64, 'base64').length;

		expect(kemCiphertextLength).toBe(1568);
		expect(wrappedMsgKeyLength).toBe(12 + senderMsgKey.length + 16);
	});

	it('rejects when unwrapping with a different ML-KEM secret key', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);
		const otherSecretKey = ml_kem1024.keygen().secretKey;

		await expect(
			DialogCrypto.unwrapSenderMsgKey(otherSecretKey, wrapped.peerKemWrapKeyB64, wrapped.peerWrappedMsgKeyB64)
		).rejects.toThrow();
	});

	it('rejects when the wrapped message key is corrupted', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);

		const corrupted = Buffer.from(wrapped.peerWrappedMsgKeyB64, 'base64');
		corrupted[corrupted.length - 1] ^= 0xff;

		await expect(
			DialogCrypto.unwrapSenderMsgKey(secretKey, wrapped.peerKemWrapKeyB64, corrupted.toString('base64'))
		).rejects.toThrow();
	});

	it('rejects when the KEM ciphertext is corrupted', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, publicKey);

		const corrupted = Buffer.from(wrapped.peerKemWrapKeyB64, 'base64');
		corrupted[corrupted.length - 1] ^= 0xff;

		await expect(
			DialogCrypto.unwrapSenderMsgKey(secretKey, corrupted.toString('base64'), wrapped.peerWrappedMsgKeyB64)
		).rejects.toThrow();
	});

	it('does not validate sender message key length — wrap/unwrap round-trips any byte length as-is', async () => {
		for (const length of [16, 50]) {
			const oddLengthKey = new Uint8Array(length).fill(9);
			const wrapped = await DialogCrypto.wrapSenderMsgKey(oddLengthKey, publicKey);
			const unwrapped = await DialogCrypto.unwrapSenderMsgKey(secretKey, wrapped.peerKemWrapKeyB64, wrapped.peerWrappedMsgKeyB64);

			expect(unwrapped).toEqual(oddLengthKey);
		}
	});
});
