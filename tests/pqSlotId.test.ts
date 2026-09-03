import { describe, it, expect } from 'vitest';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { randomBytes } from '@noble/hashes/utils';
import { deriveRootSlotUuid, bytesToUuidV8 } from '@/lib/pq/slotId';
import { hkdfDerive, hkdfExtract, hkdfExpand } from '@/lib/pq/hkdf';

const skey = (seed: number) => ml_kem1024.keygen(new Uint8Array(64).fill(seed)).secretKey;

describe('HKDF-SHA3-256', () => {
	it('extract-then-expand equals the two steps run separately', () => {
		const ikm = randomBytes(32);
		const direct = hkdfDerive(ikm, 'salt', 'info', 32);
		const stepwise = hkdfExpand(hkdfExtract(ikm, 'salt'), 'info', 32);
		expect(Array.from(direct)).toEqual(Array.from(stepwise));
	});

	it('produces exactly the requested length, including past one block', () => {
		const ikm = randomBytes(32);
		expect(hkdfDerive(ikm, 's', 'i', 16).length).toBe(16);
		expect(hkdfDerive(ikm, 's', 'i', 32).length).toBe(32);
		expect(hkdfDerive(ikm, 's', 'i', 80).length).toBe(80);
	});

	// Domain separation is the whole reason the salt exists: a future room or
	// backup key family must not be able to collide with this one.
	it('separates key families by salt and uses by info', () => {
		const ikm = randomBytes(32);
		const a = hkdfDerive(ikm, 'buckitup/a/v1', 'slot', 32);
		const b = hkdfDerive(ikm, 'buckitup/b/v1', 'slot', 32);
		const c = hkdfDerive(ikm, 'buckitup/a/v1', 'other', 32);
		expect(Array.from(a)).not.toEqual(Array.from(b));
		expect(Array.from(a)).not.toEqual(Array.from(c));
	});
});

describe('deriveRootSlotUuid', () => {
	// The defect this replaces: one constant address shared by every account,
	// letting anyone probe a stranger's user_hash for their profile.
	it('gives different accounts different root addresses', () => {
		expect(deriveRootSlotUuid(skey(1))).not.toBe(deriveRootSlotUuid(skey(2)));
	});

	// Same owner on a second device must land on the same row without any
	// registry lookup or server round trip.
	it('is deterministic for one account across derivations', () => {
		expect(deriveRootSlotUuid(skey(3))).toBe(deriveRootSlotUuid(skey(3)));
	});

	it('is canonical uuid text, version 8, RFC 4122 variant', () => {
		const uuid = deriveRootSlotUuid(skey(4));
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	// Falling back to some default address when the vault is locked would
	// reintroduce a shared constant, so this must fail loudly instead.
	it('refuses to derive without a key rather than inventing an address', () => {
		expect(() => deriveRootSlotUuid(null as never)).toThrow(/crypt_skey/);
		expect(() => deriveRootSlotUuid(new Uint8Array(0))).toThrow(/crypt_skey/);
	});

	it('is unpredictable without the key: no leading zeros pattern of the old constants', () => {
		const uuid = deriveRootSlotUuid(skey(5));
		expect(uuid.startsWith('00000000-0000-4000-8000')).toBe(false);
	});
});

describe('bytesToUuidV8', () => {
	it('sets the version and variant nibbles regardless of input bytes', () => {
		expect(bytesToUuidV8(new Uint8Array(16).fill(0))).toBe('00000000-0000-8000-8000-000000000000');
		expect(bytesToUuidV8(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-8fff-bfff-ffffffffffff');
	});

	it('rejects short input instead of padding it', () => {
		expect(() => bytesToUuidV8(new Uint8Array(15))).toThrow();
	});
});
