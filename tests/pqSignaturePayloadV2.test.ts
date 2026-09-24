import { describe, it, expect } from 'vitest';
import { canonicalPayload, encodeField } from '@/lib/pq/signature';
import { canonicalPayloadV2 } from '@/lib/pq/signaturePayloadV2';

const bytesToArray = (b: Uint8Array): number[] => Array.from(b);

describe('canonicalPayload (current wire format): known non-injective concatenation — NOT fixed here', () => {
	it('a boundary shift between two adjacent string fields collapses to the same payload (name / owner_timestamp)', () => {
		const a = canonicalPayload({ name: 'Agent7', owner_timestamp: 1_788_470_000 });
		const b = canonicalPayload({ name: 'Agent', owner_timestamp: 71_788_470_000 });
		expect(a).toBe(b);
		expect(a).toBe('Agent71788470000');
	});

	it('an array boundary shift collapses to the same payload (the "ab","c" vs "a","bc" case)', () => {
		const a = canonicalPayload({ x: ['ab', 'c'] });
		const b = canonicalPayload({ x: ['a', 'bc'] });
		expect(a).toBe(b);
		expect(a).toBe('abc');
	});
});

describe('canonicalPayloadV2: injective — same collisions do not occur', () => {
	it('does not collapse the name / owner_timestamp boundary shift', () => {
		const a = canonicalPayloadV2({ name: 'Agent7', owner_timestamp: 1_788_470_000 });
		const b = canonicalPayloadV2({ name: 'Agent', owner_timestamp: 71_788_470_000 });
		expect(bytesToArray(a)).not.toEqual(bytesToArray(b));
	});

	it('does not collapse an array element boundary shift ("ab","c" vs "a","bc")', () => {
		const a = canonicalPayloadV2({ x: ['ab', 'c'] });
		const b = canonicalPayloadV2({ x: ['a', 'bc'] });
		expect(bytesToArray(a)).not.toEqual(bytesToArray(b));
	});

	it('does not collapse a different element count at the same total length ("ab","cd" vs "abcd")', () => {
		const a = canonicalPayloadV2({ x: ['ab', 'cd'] });
		const b = canonicalPayloadV2({ x: ['abcd'] });
		expect(bytesToArray(a)).not.toEqual(bytesToArray(b));
	});

	it('distinguishes an empty string from a null value from an absent field', () => {
		const empty = canonicalPayloadV2({ a: '' });
		const nullVal = canonicalPayloadV2({ a: null });
		const absent = canonicalPayloadV2({});
		expect(bytesToArray(empty)).not.toEqual(bytesToArray(nullVal));
		expect(bytesToArray(empty)).not.toEqual(bytesToArray(absent));
		expect(bytesToArray(nullVal)).not.toEqual(bytesToArray(absent));
	});

	it('distinguishes an empty array from an absent field and from a one-element array of an empty string', () => {
		const emptyArray = canonicalPayloadV2({ x: [] });
		const absent = canonicalPayloadV2({});
		const oneEmptyElement = canonicalPayloadV2({ x: [''] });
		expect(bytesToArray(emptyArray)).not.toEqual(bytesToArray(absent));
		expect(bytesToArray(emptyArray)).not.toEqual(bytesToArray(oneEmptyElement));
	});

	it('is deterministic for the same logical input, insensitive to key insertion order', () => {
		const a = canonicalPayloadV2({ z_col: 'z', a_col: 'a', m_col: 'm' });
		const b = canonicalPayloadV2({ m_col: 'm', z_col: 'z', a_col: 'a' });
		expect(bytesToArray(a)).toEqual(bytesToArray(b));
		expect(bytesToArray(canonicalPayloadV2({ a_col: 'a' }))).toEqual(bytesToArray(canonicalPayloadV2({ a_col: 'a' })));
	});

	it('changes the bytes when any single signed field changes', () => {
		const base = { user_hash: 'u_ab', name: 'Bob', deleted_flag: false, owner_timestamp: 7 };
		const baseline = bytesToArray(canonicalPayloadV2(base));

		expect(bytesToArray(canonicalPayloadV2({ ...base, name: 'Bobby' }))).not.toEqual(baseline);
		expect(bytesToArray(canonicalPayloadV2({ ...base, owner_timestamp: 8 }))).not.toEqual(baseline);
		expect(bytesToArray(canonicalPayloadV2({ ...base, deleted_flag: true }))).not.toEqual(baseline);
		expect(bytesToArray(canonicalPayloadV2({ ...base, user_hash: 'u_ac' }))).not.toEqual(baseline);
	});

	it('drops sign_b64 and sign_hash exactly like the current payload does', () => {
		const withSig = canonicalPayloadV2({ name: 'Bob', sign_b64: 'AAAA', sign_hash: 'dms_beef' });
		const withoutSig = canonicalPayloadV2({ name: 'Bob' });
		expect(bytesToArray(withSig)).toEqual(bytesToArray(withoutSig));
	});

	it('still enforces the prefixed-hash contract on _hash fields (reuses encodeField)', () => {
		expect(() => canonicalPayloadV2({ message_sign_hash: '' })).toThrow(/prefixed hex hash/);
		expect(() => canonicalPayloadV2({ message_sign_hash: 'a'.repeat(128) })).toThrow(/prefixed hex hash/);
	});

	it('a _hash-suffixed field defers to the prefixed-hash contract even if its value is array-shaped', () => {
		expect(() => canonicalPayloadV2({ weird_hash: ['not', 'a', 'hash'] as unknown as string })).toThrow(
			/prefixed hex hash/,
		);
	});

	it('a _b64-suffixed field defers to encodeField even if its value is array-shaped, never to array framing', () => {
		const value = ['a', 'b'] as unknown as string;
		const payload = canonicalPayloadV2({ value_b64: value });
		const expectedValueBytes = new TextEncoder().encode(encodeField('value_b64', value));

		const view = new DataView(payload.buffer);
		const keyLen = view.getUint32(4);
		const valueLenOffset = 4 + 4 + keyLen;
		expect(view.getUint32(valueLenOffset)).toBe(expectedValueBytes.length);
	});

	it('handles UTF-8 non-ASCII content by byte length, not UTF-16 code unit length', () => {
		const name = 'Ũnïcödé 日本語';
		const payload = canonicalPayloadV2({ name });
		const expectedNameBytes = new TextEncoder().encode(name);
		expect(name.length).not.toBe(expectedNameBytes.length);

		const view = new DataView(payload.buffer);
		expect(view.getUint32(0)).toBe(1);
		const keyLen = view.getUint32(4);
		expect(keyLen).toBe(4);
		const valueLenOffset = 4 + 4 + keyLen;
		const valueLen = view.getUint32(valueLenOffset);
		expect(valueLen).toBe(expectedNameBytes.length);
		const valueBytes = payload.slice(valueLenOffset + 4, valueLenOffset + 4 + valueLen);
		expect(Array.from(valueBytes)).toEqual(Array.from(expectedNameBytes));

		const other = canonicalPayloadV2({ name: '日本語 Ũnïcödé' });
		expect(bytesToArray(payload)).not.toEqual(bytesToArray(other));
	});

	it('matches a hand-computed golden byte vector', () => {
		const expected = [
			0, 0, 0, 2,
			0, 0, 0, 1, 0x61,
			0, 0, 0, 1, 0x78,
			0, 0, 0, 1, 0x62,
			0, 0, 0, 1, 0x31,
		];
		expect(bytesToArray(canonicalPayloadV2({ a: 'x', b: 1 }))).toEqual(expected);
	});

	it('matches a hand-computed golden byte vector for an array field', () => {
		const ab = [0x61, 0x62];
		const c = [0x63];
		const arrayValueBytes = [
			0, 0, 0, 2,
			0, 0, 0, ab.length, ...ab,
			0, 0, 0, c.length, ...c,
		];
		const expected = [
			0, 0, 0, 1,
			0, 0, 0, 1, 0x78,
			0, 0, 0, arrayValueBytes.length, ...arrayValueBytes,
		];
		expect(bytesToArray(canonicalPayloadV2({ x: ['ab', 'c'] }))).toEqual(expected);
	});
});
