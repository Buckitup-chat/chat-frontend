// Shamir over GF(256) (shamirs-secret-sharing), as bytes in and bytes out.
// The library works on Buffers — the polyfill is why this sits in its own
// module, loaded only by the share screens — and leaves the secret and the
// combined result in Buffers the caller cannot see; both are zeroed here.
// Shares are `0x08 || x || y…`: the field size, the share's x-coordinate
// (1…n in order), then the points.
import sss from 'shamirs-secret-sharing';
import { Buffer } from 'buffer';

/** `total` shares of `secret`, any `threshold` of which give it back; share i+1 is `[i]`. */
export const shamirSplit = (secret: Uint8Array, total: number, threshold: number): Uint8Array[] => {
	const buf = Buffer.from(secret);
	try {
		return (sss.split(buf, { shares: total, threshold }) as Buffer[]).map((b) => new Uint8Array(b));
	} finally {
		buf.fill(0);
	}
};

/** The secret from shares of distinct x-coordinates; the caller dedupes and counts. */
export const shamirCombine = (shares: Uint8Array[]): Uint8Array => {
	const combined = sss.combine(shares.map((s) => Buffer.from(s))) as Buffer;
	const secret = new Uint8Array(combined);
	combined.fill(0);
	return secret;
};
