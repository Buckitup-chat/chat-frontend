import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { _setReadCacheStorageForTests, _resetTouchedForTests, setCachedRow } from '@/lib/data/readCache';

const emptyCollection = { async preload() {}, get: () => undefined };

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => emptyCollection,
}));

const { getVerifiedSignPkey, resetCardRegistry } = await import('@/lib/data/cardRegistry');

const makeCard = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed || 1);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash,
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `user-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	(card as Record<string, unknown>).sign_b64 = signFields(card as never, sign.secretKey);
	return { userHash, card, signPkeyB64: toBase64(sign.publicKey) };
};

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

beforeEach(() => {
	_setReadCacheStorageForTests(makeStorage());
	_resetTouchedForTests();
	resetCardRegistry();
});

describe('getVerifiedSignPkey: read-cache fallback when the live collection is empty (§7.3)', () => {
	it('verifies a card served only from the disk fallback', async () => {
		const { userHash, card, signPkeyB64 } = makeCard(1);
		await setCachedRow('user_cards', userHash, card);

		expect(await getVerifiedSignPkey(userHash)).toBe(signPkeyB64);
	});

	it('returns null when neither the live collection nor the disk fallback has the card', async () => {
		expect(await getVerifiedSignPkey('u_' + 'z'.repeat(128))).toBeNull();
	});

	it('still runs the disk-fallback row through full verification — a tampered cached card is rejected, not trusted', async () => {
		const { userHash, card } = makeCard(2);
		await setCachedRow('user_cards', userHash, { ...card, name: 'tampered-after-cache' });

		expect(await getVerifiedSignPkey(userHash)).toBeNull();
	});
});
