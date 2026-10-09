// The animated-QR variant: base45 against RFC 9285's own examples, the frame
// format, and the proof against what it must refuse.
import { describe, it, expect, beforeAll } from 'vitest';
import {
	checkProof, decodeProof, encodeFrame, encodeProof, fromBase45, nameBytesOf, parseFrame, proofMessage, toBase45,
	type FrameProof,
} from '../src/frames';
import { signOptical, signPq, transcript } from '../src/protocol';
import { toBytes } from '@/lib/pq/signature';
import { createIdentity, type Identity } from '../src/identity';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('base45', () => {
	it('encodes as RFC 9285 does', () => {
		expect(toBase45(utf8('AB'))).toBe('BB8');
		expect(toBase45(utf8('Hello!!'))).toBe('%69 VD92EX0');
		expect(toBase45(utf8('base-45'))).toBe('UJCLQE7W581');
		expect(new TextDecoder().decode(fromBase45('QED8WEX0')!)).toBe('ietf!');
	});

	it('round-trips any bytes, and refuses what is not base45', () => {
		const bytes = Uint8Array.from({ length: 1001 }, (_, i) => (i * 7919) & 0xff);
		expect(fromBase45(toBase45(bytes))).toEqual(bytes);
		expect(fromBase45('GGW')).toBeNull(); // 65535 + 1
		expect(fromBase45('ab')).toBeNull(); // lower case is not in the alphabet
		expect(fromBase45('A')).toBeNull(); // a lone character is no byte
	});
});

describe('frames', () => {
	const frame = { sender: '0A1B2C', index: 3, total: 25, received: 7, data: 'AB:CD $%*+-./' };

	it('round-trip, the data keeping its own colons', () => {
		expect(parseFrame(encodeFrame(frame))).toEqual(frame);
	});

	it('refuses another format, a bad sender, an index past the total and empty data', () => {
		expect(parseFrame('PQ2:A:x')).toBeNull();
		expect(parseFrame(encodeFrame({ ...frame, sender: 'zz' }))).toBeNull();
		expect(parseFrame(encodeFrame({ ...frame, index: 25 }))).toBeNull();
		expect(parseFrame(encodeFrame({ ...frame, data: '' }))).toBeNull();
	});
});

describe('the proof', () => {
	let alice: Identity;
	let mallory: Identity;
	let T: Uint8Array;
	let proof: FrameProof;
	const bound = () => ({ userHash: alice.userHash, contactPkey: alice.contactPkey });

	beforeAll(async () => {
		alice = createIdentity('Alice');
		mallory = createIdentity('Mallory');
		const bob = createIdentity('Bob');
		T = transcript(
			{ userHash: alice.userHash, contactPkey: alice.contactPkey, nonce: new Uint8Array(16).fill(1) },
			{ userHash: bob.userHash, contactPkey: bob.contactPkey, nonce: new Uint8Array(16).fill(2) },
		);
		const nameBytes = nameBytesOf('Alice');
		proof = {
			opticalSig: await signOptical(T, alice.contactSkey),
			signPkey: toBytes(alice.card.sign_pkey!),
			pqSig: signPq(proofMessage(T, nameBytes), alice.signSkey),
			nameBytes,
		};
	});

	it('round-trips, and confirms the identity the codes showed', () => {
		expect(decodeProof(encodeProof(proof))).toEqual(proof);
		expect(checkProof(proof, bound(), T)).toEqual({ ok: true, name: 'Alice' });
	});

	it('refuses an identity key it does not sign with, another identity, another name and another session', async () => {
		// Mallory shows Alice's user_hash and key, and signs with her own identity key.
		const forged = { ...proof, pqSig: signPq(proofMessage(T, proof.nameBytes), mallory.signSkey) };
		expect(checkProof(forged, bound(), T)).toEqual({ ok: false, reason: 'post-quantum signature does not verify' });
		expect(checkProof({ ...proof, signPkey: toBytes(mallory.card.sign_pkey!) }, bound(), T)).toMatchObject({ reason: expect.stringMatching(/another identity/) });
		expect(checkProof({ ...proof, nameBytes: nameBytesOf('Eve') }, bound(), T)).toMatchObject({ reason: expect.stringMatching(/post-quantum/) });
		const other = new Uint8Array(T);
		other[T.length - 1] ^= 1;
		expect(checkProof(proof, bound(), other)).toMatchObject({ reason: expect.stringMatching(/optical/) });
	});

	it('refuses bytes that are not a proof', () => {
		const bytes = encodeProof(proof);
		expect(decodeProof(bytes.slice(0, -100))).toBeNull();
		expect(decodeProof(Uint8Array.of(2, ...bytes.slice(1)))).toBeNull();
	});
});
