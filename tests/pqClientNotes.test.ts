// @buckitup/pq-client/notes and derivedIdentity: notes to self as dialogs of
// identities derived from the account's keys (pq_notes_to_self.proposed.md).
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { deriveIdentity, derivedCardName, signedUserCard, userHashOf } from '@buckitup/pq-client/derivedIdentity';
import { NOTE_PEER_SALT, NOTES_IDENTITY_SALT, deriveNotesIdentity, isNoteId, newNoteId, notePeers } from '@buckitup/pq-client/notes';
import {
	decryptContent,
	deriveSenderMsgKey,
	dialogHash,
	encryptContent,
	unwrapSenderMsgKey,
	wrapSenderMsgKey,
} from '@buckitup/pq-client/dialogs';
import { verifyUserCard } from '@buckitup/pq-client/verifyCard';
import { makeTestIdentity } from './helpers/signedFixtures';

const utf8 = (s: string) => new TextEncoder().encode(s);

// A fixed account: the vectors below depend on nothing random.
const fixed = makeTestIdentity(1);
const account = { signSkey: fixed.signSkey, cryptSkey: fixed.kemSkey };
const NOTE_ID = '00112233445566778899aabbccddeeff';
const notes = deriveNotesIdentity(account);
const peers = notePeers(notes);
const peer = peers.identity(NOTE_ID);

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

describe('derived identities', () => {
	it('derive each key from the parent keys by HKDF with the family salt and the label', () => {
		const ikm = concatBytes(account.signSkey, account.cryptSkey);
		const sign = ml_dsa87.keygen(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('sign'), 32));
		const crypt = ml_kem1024.keygen(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('crypt'), 64));
		const contact = secp.etc.hashToPrivateKey(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('contact'), 48));
		expect(bytesToHex(notes.signPkey)).toBe(bytesToHex(sign.publicKey));
		expect(bytesToHex(notes.cryptPkey)).toBe(bytesToHex(crypt.publicKey));
		expect(bytesToHex(notes.contactSkey)).toBe(bytesToHex(contact));
		expect(bytesToHex(notes.contactPkey)).toBe(bytesToHex(secp.getPublicKey(contact, true)));
		expect(notes.userHash).toBe(userHashOf(sign.publicKey));
	});

	it('prefix a note peer\'s labels with the note id\'s bytes', () => {
		const ikm = concatBytes(notes.signSkey, notes.cryptSkey);
		const sign = ml_dsa87.keygen(hkdf(ikm, NOTE_PEER_SALT, concatBytes(hexToBytes(NOTE_ID), utf8('sign')), 32));
		expect(peer.userHash).toBe(userHashOf(sign.publicKey));
		expect(peers.userHash(NOTE_ID)).toBe(peer.userHash);
	});

	it('pin the identities of a fixed account', () => {
		expect(notes.userHash.slice(0, 34)).toBe('u_3e5b3d64e60bc1dc27d12068a4c15f06');
		expect(bytesToHex(sha3_256(notes.cryptPkey))).toBe('f3cb106083609ae4638f9655d1a6ee8dfbe4920c47a4cb517d7a137c9fb3bf7f');
		expect(bytesToHex(notes.contactPkey)).toBe('028c42eb0597e65912278c534c8445330ce32c406dab12e52aab1cb2c819a89463');
		expect(peer.userHash.slice(0, 34)).toBe('u_fffa749e44b66ae1a4cd1399369b9580');
		expect(derivedCardName(notes.userHash)).toBe('Rafa');
	});

	it('are the same on every derivation, and distinct across families, notes and parents', () => {
		expect(deriveNotesIdentity(account).userHash).toBe(notes.userHash);
		const hashes = new Set([
			fixed.userHash,
			notes.userHash,
			peer.userHash,
			peers.userHash(newNoteId()),
			deriveIdentity(account, NOTE_PEER_SALT, hexToBytes(NOTE_ID)).userHash, // a peer salt under the account
		]);
		expect(hashes.size).toBe(5);
	});

	it('publish a card that verifies like any account\'s, under the name its key picks', () => {
		const card = signedUserCard(notes, 1_700_000_000);
		expect(card.name).toBe(derivedCardName(notes.userHash));
		expect(verifyUserCard(card).status).toBe('verified');
		// a changed name breaks the self-signature
		expect(verifyUserCard({ ...card, name: 'Someone' }).status).toBe('invalid');
	});
});

describe('note ids', () => {
	it('are 16 random bytes in lowercase hex', () => {
		const id = newNoteId();
		expect(isNoteId(id)).toBe(true);
		expect(newNoteId()).not.toBe(id);
		expect(isNoteId('00112233445566778899AABBCCDDEEFF')).toBe(false);
		expect(() => peers.userHash('note-1')).toThrow(/note id/);
	});
});

describe('a note', () => {
	it('is an ordinary dialog: the notes identity writes, re-derives its key, and the peer could unwrap it', async () => {
		const key = deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, peer.userHash);
		expect(dialogHash(notes.userHash, peer.userHash)).toMatch(/^di_[0-9a-f]{128}$/);

		const wrapped = await wrapSenderMsgKey(key, peer.cryptPkey);
		expect(await unwrapSenderMsgKey(peer.cryptSkey, wrapped.peer_kem_wrap_key_b64, wrapped.peer_wrapped_msg_key_b64)).toEqual(key);

		const content = await encryptContent(key, '"buy milk"');
		const again = deriveNotesIdentity(account); // another device
		const peerHash = notePeers(again).userHash(NOTE_ID);
		expect(await decryptContent(deriveSenderMsgKey(again.signSkey, again.cryptSkey, peerHash), content)).toBe('"buy milk"');
	});

	it('has a key of its own', () => {
		expect(deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, peer.userHash))
			.not.toEqual(deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, peers.userHash(newNoteId())));
	});
});
