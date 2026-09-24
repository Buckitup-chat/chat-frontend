import { encodeField, toBase64, NOT_SIGNED, type SignableFields, type SignableValue } from './signature';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const u32be = (n: number): Uint8Array => {
	if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
		throw new RangeError(`u32be: ${n} does not fit in an unsigned 32-bit length field`);
	}
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n);
	return b;
};

const framed = (bytes: Uint8Array): Uint8Array[] => [u32be(bytes.length), bytes];

const concatAll = (chunks: Uint8Array[]): Uint8Array => {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) { out.set(c, offset); offset += c.length; }
	return out;
};

const arrayValueBytes = (value: Array<string | Uint8Array>): Uint8Array => {
	const elements = value.map((el) => (typeof el === 'string' ? el : toBase64(el)));
	const parts: Uint8Array[] = [u32be(elements.length)];
	for (const el of elements) parts.push(...framed(utf8(el)));
	return concatAll(parts);
};

const hasScalarSuffix = (key: string): boolean =>
	key.endsWith('_b64') || key.endsWith('_cert') || key.endsWith('_pkey') || key.endsWith('_hash');

const fieldValueBytes = (key: string, value: SignableValue): Uint8Array =>
	!hasScalarSuffix(key) && Array.isArray(value) ? arrayValueBytes(value) : utf8(encodeField(key, value));

export const canonicalPayloadV2 = (fields: SignableFields): Uint8Array => {
	const keys = Object.keys(fields)
		.filter((key) => !NOT_SIGNED.has(key))
		.sort();

	const parts: Uint8Array[] = [u32be(keys.length)];
	for (const key of keys) {
		parts.push(...framed(utf8(key)));
		parts.push(...framed(fieldValueBytes(key, fields[key])));
	}
	return concatAll(parts);
};
