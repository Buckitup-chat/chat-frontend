// The PQ2 pure functions against values computed independently here: the
// transcript by hand from its definition, the comparison code with noble's
// own RFC 5869 HKDF over SHA3-256 (the module uses the app's hand-rolled one).
import { describe, it, expect, beforeAll } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { sha3_256 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';
import { concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import {
	checkConfirm, comparisonCode, confirmMessage, encode, parse, pqMessage, signOptical, signPq, transcript,
	verifyOptical, type Party,
} from '../src/protocol';
import { createIdentity, type Identity } from '../src/identity';

const utf8 = (s: string) => new TextEncoder().encode(s);
const HASH_A = 'u_' + 'a'.repeat(128);
const HASH_B = 'u_' + 'b'.repeat(128);
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const partyA: Party = { userHash: HASH_A, contactPkey: Uint8Array.of(2, ...fill(32, 0x11)), nonce: fill(16, 0x21) };
const partyB: Party = { userHash: HASH_B, contactPkey: Uint8Array.of(3, ...fill(32, 0x12)), nonce: fill(16, 0x22) };
const FP_A = fill(32, 0xa1);
const FP_B = fill(32, 0xb2);

describe('messages', () => {
	it('round-trips every kind', () => {
		const sig = fill(64, 7);
		const qwbp = fill(70, 9);
		for (const m of [
			{ kind: 'A', ...partyA },
			{ kind: 'B', ...partyA, sig },
			{ kind: 'C', sig, qwbp },
			{ kind: 'D', tag: fill(6, 3), qwbp },
		] as const) {
			expect(parse(encode(m))).toEqual(m);
		}
	});

	it('refuses a PQ1 code, a missing or extra field, a field of the wrong length, and a malformed user_hash', () => {
		const a = encode({ kind: 'A', ...partyA });
		expect(parse(a.replace('PQ2', 'PQ1'))).toBeNull();
		expect(parse(a.split(':').slice(0, -1).join(':'))).toBeNull();
		expect(parse(`${a}:x`)).toBeNull();
		expect(parse(encode({ kind: 'A', ...partyA, nonce: fill(15, 1) }))).toBeNull();
		expect(parse(encode({ kind: 'A', ...partyA, userHash: 'u_' + 'g'.repeat(128) }))).toBeNull();
		expect(parse(encode({ kind: 'C', sig: fill(63, 1), qwbp: fill(70, 1) }))).toBeNull();
		expect(parse('https://example.com')).toBeNull();
	});

	it('refuses a field in anything but unpadded base64url', () => {
		const a = encode({ kind: 'A', ...partyA, nonce: fill(16, 0xfb) });
		const cut = a.lastIndexOf(':') + 1;
		const [head, nonce] = [a.slice(0, cut), a.slice(cut)];
		expect(nonce).toMatch(/-/);
		for (const variant of [nonce.replaceAll('-', '+'), `${nonce}==`, ` ${nonce}`]) {
			expect(parse(head + variant), variant).toBeNull();
		}
	});
});

describe('the transcript', () => {
	it('is the definition, byte for byte, whichever side computes it', () => {
		const expected = concatBytes(
			utf8('buckitup/handshake/v2\n'),
			utf8(HASH_A), partyA.contactPkey, partyA.nonce,
			utf8(HASH_B), partyB.contactPkey, partyB.nonce,
		);
		expect(transcript(partyA, partyB)).toEqual(expected);
		expect(transcript(partyB, partyA)).toEqual(expected);
	});

	it('refuses a party handshaking with itself', () => {
		expect(() => transcript(partyA, { ...partyA, nonce: fill(16, 9) })).toThrow(/itself/);
	});
});

describe('the comparison code', () => {
	const T = transcript(partyA, partyB);
	const fps = { [HASH_A]: FP_A, [HASH_B]: FP_B };

	it('is HKDF-SHA3-256 over T and both fingerprints in transcript order, mod 10^6', () => {
		const out = hkdf(sha3_256, concatBytes(T, FP_A, FP_B), utf8('buckitup/handshake/v2'), utf8('sas'), 4);
		const n = new DataView(out.buffer, out.byteOffset, 4).getUint32(0);
		expect(comparisonCode(T, HASH_B, HASH_A, fps)).toBe(String(n % 1_000_000).padStart(6, '0'));
		// Pinned: a changed tag, order or encoding must fail here first.
		expect(comparisonCode(T, HASH_A, HASH_B, fps)).toBe(PINNED_CODE);
	});

	it('changes when a channel fingerprint changes: a swapped channel shows different digits', () => {
		expect(comparisonCode(T, HASH_A, HASH_B, { ...fps, [HASH_B]: fill(32, 0xb3) })).not.toBe(comparisonCode(T, HASH_A, HASH_B, fps));
	});

	it('the post-quantum message is the tag, T and the fingerprints in transcript order', () => {
		expect(pqMessage(T, HASH_B, HASH_A, fps)).toEqual(concatBytes(utf8('buckitup/handshake/v2/pq\n'), T, FP_A, FP_B));
	});
});

describe('the optical proof', () => {
	const skey = hexToBytes('11'.repeat(32));
	const T = transcript({ ...partyA, contactPkey: secp.getPublicKey(skey, true) }, partyB);

	it('verifies under the key that signed T', async () => {
		expect(verifyOptical(await signOptical(T, skey), T, secp.getPublicKey(skey, true))).toBe(true);
	});

	it('does not verify under another key, over another session, or as a signature of the bare nonce', async () => {
		const sig = await signOptical(T, skey);
		expect(verifyOptical(sig, T, secp.getPublicKey(hexToBytes('22'.repeat(32)), true))).toBe(false);
		const other = transcript({ ...partyA, contactPkey: secp.getPublicKey(skey, true), nonce: fill(16, 0x99) }, partyB);
		expect(verifyOptical(sig, other, secp.getPublicKey(skey, true))).toBe(false);
		const bare = (await secp.signAsync(sha256(partyB.nonce), skey)).toCompactRawBytes();
		expect(verifyOptical(bare, T, secp.getPublicKey(skey, true))).toBe(false);
	});
});

describe('the confirmation over the channel', () => {
	let alice: Identity;
	let bob: Identity;
	let T: Uint8Array;
	let M: Uint8Array;
	const bound = () => ({ userHash: alice.userHash, contactPkey: alice.contactPkey });

	beforeAll(() => {
		alice = createIdentity('Alice');
		bob = createIdentity('Bob');
		const pa = { userHash: alice.userHash, contactPkey: alice.contactPkey, nonce: fill(16, 1) };
		const pb = { userHash: bob.userHash, contactPkey: bob.contactPkey, nonce: fill(16, 2) };
		T = transcript(pa, pb);
		M = pqMessage(T, alice.userHash, bob.userHash, { [alice.userHash]: FP_A, [bob.userHash]: FP_B });
	});

	it('confirms the identity the codes showed, with its card and its signature over M', () => {
		const verdict = checkConfirm(confirmMessage(alice.card, signPq(M, alice.signSkey)), bound(), M);
		expect(verdict.ok).toBe(true);
	});

	it('refuses a valid card of someone else shown under the codes\' identity (impersonation)', () => {
		// Mallory showed Alice's user_hash with her own contact key and sends Alice's card.
		const mallory = createIdentity('Mallory');
		const verdict = checkConfirm(confirmMessage(alice.card, signPq(M, mallory.signSkey)), { userHash: alice.userHash, contactPkey: mallory.contactPkey }, M);
		expect(verdict).toEqual({ ok: false, reason: 'card does not certify the contact key the codes showed' });
	});

	it('refuses a card of another identity, a tampered card, a signature by another key, and a signature over another channel', () => {
		expect(checkConfirm(confirmMessage(bob.card, signPq(M, bob.signSkey)), bound(), M)).toMatchObject({ ok: false, reason: expect.stringMatching(/another identity/) });
		expect(checkConfirm(confirmMessage({ ...alice.card, name: 'Eve' }, signPq(M, alice.signSkey)), bound(), M)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not verify/) });
		expect(checkConfirm(confirmMessage(alice.card, signPq(M, bob.signSkey)), bound(), M)).toMatchObject({ ok: false, reason: expect.stringMatching(/post-quantum/) });
		const otherChannel = pqMessage(T, alice.userHash, bob.userHash, { [alice.userHash]: FP_A, [bob.userHash]: fill(32, 0xee) });
		expect(checkConfirm(confirmMessage(alice.card, signPq(otherChannel, alice.signSkey)), bound(), M)).toMatchObject({ ok: false, reason: expect.stringMatching(/post-quantum/) });
	});
});

// Pinned from the independent HKDF computation in the test above.
const PINNED_CODE = '190696';
