import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { encryptChunk, decryptChunk, chunkDataHash, chunkCountOf, generateEncSecret, newFileId, CHUNK_SIZE } from '@/lib/pq/fileCrypto';

describe('chunk crypto', () => {
	it('round-trips bytes through encrypt/decrypt', async () => {
		const secret = generateEncSecret();
		const plain = randomBytes(1000);
		const out = await decryptChunk(secret, await encryptChunk(secret, plain));
		expect(Array.from(out)).toEqual(Array.from(plain));
	});

	it('produces nonce||ct||tag with a fresh nonce per call', async () => {
		const secret = generateEncSecret();
		const plain = randomBytes(64);
		const a = await encryptChunk(secret, plain);
		const b = await encryptChunk(secret, plain);
		expect(a.length).toBe(12 + 64 + 16);
		expect(Array.from(a.slice(0, 12))).not.toEqual(Array.from(b.slice(0, 12)));
	});

	// GCM is the end-to-end integrity: a flipped byte anywhere must fail
	// decryption, not decode into garbage the UI would show.
	it('rejects a tampered chunk', async () => {
		const secret = generateEncSecret();
		const enc = await encryptChunk(secret, randomBytes(128));
		enc[20] ^= 0xff;
		await expect(decryptChunk(secret, enc)).rejects.toThrow();
	});

	it('rejects a chunk under the wrong secret', async () => {
		const enc = await encryptChunk(generateEncSecret(), randomBytes(128));
		await expect(decryptChunk(generateEncSecret(), enc)).rejects.toThrow();
	});

	it('data hash has the fd_ shape the server CHECK enforces', async () => {
		expect(chunkDataHash(randomBytes(10))).toMatch(/^fd_[a-f0-9]{128}$/);
	});

	it('file id strips uuid dashes to the 32-hex server shape', () => {
		expect(newFileId('01912345-abcd-7def-8123-456789abcdef')).toMatch(/^f_[a-f0-9]{32}$/);
	});

	it('chunk count covers the tail and the empty file', () => {
		expect(chunkCountOf(1)).toBe(1);
		expect(chunkCountOf(CHUNK_SIZE)).toBe(1);
		expect(chunkCountOf(CHUNK_SIZE + 1)).toBe(2);
		expect(chunkCountOf(0)).toBe(1);
	});
});
