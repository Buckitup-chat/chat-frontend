// @buckitup/pq-client/notes and derivedIdentity: notes to self as dialogs of
// identities derived from the account's keys (pq_notes_to_self.proposed.md).
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { DERIVED_CARD_NAMES, deriveIdentity, signedUserCard, type DerivedIdentity, type ParentKeys } from '@buckitup/pq-client/derivedIdentity';
import { NOTE_PEER_SALT, NOTES_IDENTITY_SALT, accountNotes, isNoteId, newNoteId } from '@buckitup/pq-client/notes';
import {
	decryptContent,
	deriveSenderMsgKey,
	dialogHash,
	encryptContent,
	unwrapSenderMsgKey,
	wrapSenderMsgKey,
} from '@buckitup/pq-client/dialogs';
import { userHashOf, verifyUserCard } from '@buckitup/pq-client/verifyCard';
import { makeTestIdentity } from './helpers/signedFixtures';

const utf8 = (s: string) => new TextEncoder().encode(s);

// A fixed account: the vectors below depend on nothing random.
const fixed = makeTestIdentity(1);
const account = { signSkey: fixed.signSkey, cryptSkey: fixed.kemSkey };
const NOTE_ID = '00112233445566778899aabbccddeeff';
const notes = accountNotes(account);
const peer = notes.peer(NOTE_ID);

// RFC 5869 over HMAC-SHA3-256, written out here rather than imported, so the
// vectors do not lean on the module under test.
const hkdf = (ikm: Uint8Array, salt: string, info: Uint8Array, length: number) => {
	const prk = hmac(sha3_256, utf8(salt), ikm);
	let t = new Uint8Array(0);
	const out: Uint8Array[] = [];
	for (let i = 1; out.length * 32 < length; i++) {
		t = hmac(sha3_256, prk, concatBytes(t, info, Uint8Array.of(i)));
		out.push(t);
	}
	return concatBytes(...out).slice(0, length);
};

/** Every key of `id`, made from the reference HKDF over `parent`. */
const expectDerivedBy = (id: DerivedIdentity, parent: ParentKeys, salt: string, prefix: Uint8Array) => {
	const ikm = concatBytes(parent.signSkey, parent.cryptSkey);
	const info = (label: string) => concatBytes(prefix, utf8(label));
	const sign = ml_dsa87.keygen(hkdf(ikm, salt, info('sign'), 32));
	const crypt = ml_kem1024.keygen(hkdf(ikm, salt, info('crypt'), 64));
	const contact = secp.etc.hashToPrivateKey(hkdf(ikm, salt, info('contact'), 48));
	expect(bytesToHex(id.signPkey)).toBe(bytesToHex(sign.publicKey));
	expect(bytesToHex(id.signSkey)).toBe(bytesToHex(sign.secretKey));
	expect(bytesToHex(id.cryptPkey)).toBe(bytesToHex(crypt.publicKey));
	expect(bytesToHex(id.cryptSkey)).toBe(bytesToHex(crypt.secretKey));
	expect(bytesToHex(id.contactSkey)).toBe(bytesToHex(contact));
	expect(bytesToHex(id.contactPkey)).toBe(bytesToHex(secp.getPublicKey(contact, true)));
	expect(id.userHash).toBe(userHashOf(sign.publicKey));
};

describe('derived identities', () => {
	it('derive the notes identity\'s keys from the account\'s by HKDF with the family salt and the label', () => {
		expectDerivedBy(notes.identity, account, NOTES_IDENTITY_SALT, new Uint8Array(0));
	});

	it('derive a note peer\'s keys from the notes identity\'s, the note id\'s bytes before each label', () => {
		expectDerivedBy(peer, notes.identity, NOTE_PEER_SALT, hexToBytes(NOTE_ID));
		expect(notes.peerHash(NOTE_ID)).toBe(peer.userHash);
	});

	it('pin the identities of a fixed account', () => {
		expect(notes.identity.userHash).toBe('u_3e5b3d64e60bc1dc27d12068a4c15f06b9ee6827b8f8ad0506141c30ee6ac8792a36892e294c35322e2971c3080640843454ab0c7b2c6eef405199c2f7bbdda5');
		expect(bytesToHex(sha3_256(notes.identity.cryptPkey))).toBe('f3cb106083609ae4638f9655d1a6ee8dfbe4920c47a4cb517d7a137c9fb3bf7f');
		expect(bytesToHex(notes.identity.contactPkey)).toBe('028c42eb0597e65912278c534c8445330ce32c406dab12e52aab1cb2c819a89463');
		expect(notes.identity.cardName).toBe('Ella');
		expect(peer.userHash).toBe('u_fffa749e44b66ae1a4cd1399369b9580b8a5b0b4f87df831006559da397c08b0484dbe6f7a6287f6e7e264a2270782e6a0ddf8a4838139514f7656f0da6303f1');
		expect(bytesToHex(sha3_256(peer.cryptPkey))).toBe('697a10d38c997f081e92655d413b6a5a926fd84cd98650f301c73ee50d99def8');
		expect(bytesToHex(peer.contactPkey)).toBe('0213a733b73b0f2502eb689135a2bdc5071227ef1e5c5c63b762ecad94a47fbe18');
		expect(peer.cardName).toBe('Viktor');
	});

	it('are the same on every derivation, and distinct across families, notes and parents', () => {
		const again = accountNotes(account); // another device
		expect(again.identity.userHash).toBe(notes.identity.userHash);
		expect(again.peerHash(NOTE_ID)).toBe(peer.userHash);
		const hashes = new Set([
			fixed.userHash,
			notes.identity.userHash,
			peer.userHash,
			notes.peerHash(newNoteId()),
			deriveIdentity(account, NOTE_PEER_SALT, hexToBytes(NOTE_ID)).userHash, // a peer salt under the account
		]);
		expect(hashes.size).toBe(5);
	});

	it('take a card name from secret bytes, so the public card does not tell it is derived', () => {
		const nameOf = (parent: ParentKeys, salt: string, prefix: Uint8Array) =>
			DERIVED_CARD_NAMES[hkdf(concatBytes(parent.signSkey, parent.cryptSkey), salt, concatBytes(prefix, utf8('name')), 1)[0] % 64];
		expect(DERIVED_CARD_NAMES).toHaveLength(64);
		expect(notes.identity.cardName).toBe(nameOf(account, NOTES_IDENTITY_SALT, new Uint8Array(0)));
		expect(peer.cardName).toBe(nameOf(notes.identity, NOTE_PEER_SALT, hexToBytes(NOTE_ID)));
	});

	it('publish a card that verifies like any account\'s, under the derived name', () => {
		const card = signedUserCard(notes.identity, 1_700_000_000);
		expect(card.name).toBe(notes.identity.cardName);
		expect(verifyUserCard(card).status).toBe('verified');
		// a changed name breaks the self-signature
		expect(verifyUserCard({ ...card, name: 'Someone' }).status).toBe('invalid');
	});

	it('refuse a card the server would refuse: an empty name, a timestamp that is not a positive integer', () => {
		expect(() => signedUserCard(notes.identity, 1_700_000_000, '')).toThrow(/name/);
		expect(() => signedUserCard(notes.identity, 1_700_000_000.5)).toThrow(/owner_timestamp/);
		expect(() => signedUserCard(notes.identity, Number.NaN)).toThrow(/owner_timestamp/);
	});
});

describe('note ids', () => {
	it('are 16 random bytes in lowercase hex', () => {
		const id = newNoteId();
		expect(isNoteId(id)).toBe(true);
		expect(newNoteId()).not.toBe(id);
		expect(isNoteId('00112233445566778899AABBCCDDEEFF')).toBe(false);
		expect(() => notes.peerHash('note-1')).toThrow(/note id/);
	});
});

describe('a note', () => {
	it('is an ordinary dialog: the notes identity writes, re-derives its key, and the peer could unwrap it', async () => {
		const author = notes.identity;
		const key = deriveSenderMsgKey(author.signSkey, author.cryptSkey, peer.userHash);
		expect(dialogHash(author.userHash, peer.userHash)).toMatch(/^di_[0-9a-f]{128}$/);

		const wrapped = await wrapSenderMsgKey(key, peer.cryptPkey);
		expect(await unwrapSenderMsgKey(peer.cryptSkey, wrapped.peer_kem_wrap_key_b64, wrapped.peer_wrapped_msg_key_b64)).toEqual(key);

		const content = await encryptContent(key, '"buy milk"');
		const again = accountNotes(account); // another device
		const againKey = deriveSenderMsgKey(again.identity.signSkey, again.identity.cryptSkey, again.peerHash(NOTE_ID));
		expect(await decryptContent(againKey, content)).toBe('"buy milk"');
	});

	it('has a key of its own', () => {
		const { signSkey, cryptSkey } = notes.identity;
		expect(deriveSenderMsgKey(signSkey, cryptSkey, peer.userHash))
			.not.toEqual(deriveSenderMsgKey(signSkey, cryptSkey, notes.peerHash(newNoteId())));
	});
});

describe('wiping', () => {
	it('derives a peer\'s signing key alone, and nothing once wiped', () => {
		const own = accountNotes(account);
		expect(own.peerSignSkey(NOTE_ID)).toEqual(peer.signSkey);
		own.wipe();
		expect(own.identity.signSkey.every((b) => b === 0)).toBe(true);
		expect(() => own.peerHash(NOTE_ID)).toThrow(/wiped/);
		expect(() => own.peer(NOTE_ID)).toThrow(/wiped/);
		expect(() => own.peerSignSkey(NOTE_ID)).toThrow(/wiped/);
	});
});
