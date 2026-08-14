import { describe, it, expect } from 'vitest';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { makeKey, THUMBS_UP_WITH_SKIN_TONE } from './dialogCrypto.fixtures';

describe('DialogCrypto.encryptContent / decryptContent', () => {
	const key = makeKey(1);

	it('round-trips plain ASCII JSON through encrypt then decrypt', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);
		const decrypted = await DialogCrypto.decryptContent(key, contentB64);
		expect(decrypted).toBe(plaintext);
	});

	it('round-trips unicode and emoji', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: `Привіт, світ! ${THUMBS_UP_WITH_SKIN_TONE} café naïve 日本語` });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);
		const decrypted = await DialogCrypto.decryptContent(key, contentB64);
		expect(decrypted).toBe(plaintext);
	});

	it('round-trips an empty plaintext string', async () => {
		const contentB64 = await DialogCrypto.encryptContent(key, '');
		const decrypted = await DialogCrypto.decryptContent(key, contentB64);
		expect(decrypted).toBe('');
	});

	it('decryptContent returns "" for an empty ciphertext string without attempting to decrypt (deleted-flag guard)', async () => {
		const decrypted = await DialogCrypto.decryptContent(key, '');
		expect(decrypted).toBe('');
	});

	it('round-trips a longer JSON payload', async () => {
		const plaintext = JSON.stringify({
			type: 'text',
			text: 'Lorem ipsum dolor sit amet, '.repeat(50),
			refs: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ref_${i}`, `value_${i}`])),
		});
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);
		const decrypted = await DialogCrypto.decryptContent(key, contentB64);
		expect(decrypted).toBe(plaintext);
	});

	it('produces a different ciphertext each time for the same key and plaintext (random nonce)', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'same message twice' });
		const first = await DialogCrypto.encryptContent(key, plaintext);
		const second = await DialogCrypto.encryptContent(key, plaintext);

		expect(first).not.toBe(second);
		expect(await DialogCrypto.decryptContent(key, first)).toBe(plaintext);
		expect(await DialogCrypto.decryptContent(key, second)).toBe(plaintext);
	});

	it('does not contain the plaintext marker in the encoded payload', async () => {
		const marker = 'SUPER_SECRET_MARKER_TEXT';
		const plaintext = JSON.stringify({ type: 'text', text: marker });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		expect(contentB64).not.toContain(marker);
		expect(Buffer.from(contentB64, 'base64').toString('latin1')).not.toContain(marker);
	});

	it('rejects when decrypting with the wrong key', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		await expect(DialogCrypto.decryptContent(makeKey(2), contentB64)).rejects.toThrow();
	});

	it('rejects when a single ciphertext byte is flipped', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		const raw = Buffer.from(contentB64, 'base64');
		raw[raw.length - 1] ^= 0xff;

		await expect(DialogCrypto.decryptContent(key, raw.toString('base64'))).rejects.toThrow();
	});

	it('rejects when the ciphertext is truncated', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		const raw = Buffer.from(contentB64, 'base64');
		const truncated = raw.subarray(0, raw.length - 5);

		await expect(DialogCrypto.decryptContent(key, truncated.toString('base64'))).rejects.toThrow();
	});

	it('rejects predictably when the AES key has the wrong length (encrypt)', async () => {
		await expect(DialogCrypto.encryptContent(makeKey(1).slice(0, 31), 'x')).rejects.toThrow();
	});

	it('rejects predictably when the AES key has the wrong length (decrypt)', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		await expect(DialogCrypto.decryptContent(makeKey(1).slice(0, 31), contentB64)).rejects.toThrow();
	});

	it('produces base64 output shaped as 12-byte nonce + ciphertext + 16-byte GCM tag', async () => {
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });
		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);

		expect(contentB64).toMatch(/^[A-Za-z0-9+/]+=*$/);

		const raw = Buffer.from(contentB64, 'base64');
		const plaintextByteLength = Buffer.byteLength(plaintext, 'utf-8');
		expect(raw.length).toBe(12 + plaintextByteLength + 16);
	});
});
