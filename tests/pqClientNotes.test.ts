// @buckitup/pq-client/notes and derivedIdentity: notes to self as dialogs of
// identities derived from the account's keys (pq_notes_to_self.proposed.md).
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256, sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { deriveIdentity, signedUserCard } from '@buckitup/pq-client/derivedIdentity';
import {
	NOTE_PEER_SALT,
	NOTES_IDENTITY_SALT,
	derivedCardName,
	deriveNotePeer,
	deriveNotesIdentity,
	isNoteId,
	newNoteId,
} from '@buckitup/pq-client/notes';
import {
	decryptContent,
	deriveSenderMsgKey,
	dialogHash,
	encryptContent,
	unwrapSenderMsgKey,
	wrapSenderMsgKey,
} from '@buckitup/pq-client/dialogs';
import { verifyUserCard } from '@buckitup/pq-client/verifyCard';

const utf8 = (s: string) => new TextEncoder().encode(s);

// A fixed account: the vectors below depend on nothing random.
const accountSign = ml_dsa87.keygen(new Uint8Array(32).fill(1));
const accountCrypt = ml_kem1024.keygen(new Uint8Array(64).fill(2));
const account = { signSkey: accountSign.secretKey, cryptSkey: accountCrypt.secretKey };
const NOTE_ID = '00112233445566778899aabbccddeeff';

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

const userHashOf = (signPkey: Uint8Array) => 'u_' + bytesToHex(sha3_512(signPkey));

describe('derived identities', () => {
	it('derive each key from the parent keys by HKDF with the family salt and the label', () => {
		const ikm = concatBytes(account.signSkey, account.cryptSkey);
		const notes = deriveNotesIdentity(account);
		const sign = ml_dsa87.keygen(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('sign'), 32));
		const crypt = ml_kem1024.keygen(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('crypt'), 64));
		const contact = secp.etc.hashToPrivateKey(hkdf(ikm, NOTES_IDENTITY_SALT, utf8('contact'), 48));
		expect(bytesToHex(notes.signPkey)).toBe(bytesToHex(sign.publicKey));
		expect(bytesToHex(notes.cryptPkey)).toBe(bytesToHex(crypt.publicKey));
		expect(bytesToHex(notes.contactSkey)).toBe(bytesToHex(contact));
		expect(notes.userHash).toBe(userHashOf(sign.publicKey));
	});

	it('prefix a note peer\'s labels with the note id\'s bytes', () => {
		const notes = deriveNotesIdentity(account);
		const ikm = concatBytes(notes.signSkey, notes.cryptSkey);
		const info = (label: string) => concatBytes(hexToBytes(NOTE_ID), utf8(label));
		const sign = ml_dsa87.keygen(hkdf(ikm, NOTE_PEER_SALT, info('sign'), 32));
		expect(deriveNotePeer(notes, NOTE_ID).userHash).toBe(userHashOf(sign.publicKey));
	});

	it('pin the identities of a fixed account', () => {
		const notes = deriveNotesIdentity(account);
		const peer = deriveNotePeer(notes, NOTE_ID);
		expect(notes.userHash.slice(0, 34)).toBe('u_82a3bbeee73403b54caab7431dc1ac55');
		expect(bytesToHex(sha3_256(notes.cryptPkey))).toBe('3090e73cc0c28596c4d63b4d4a418687222a44f9920d67ad460e8290c1511c42');
		expect(bytesToHex(notes.contactPkey)).toBe('02a1ae883b4e8a501c89bfd8a2e3e80fc50e2ea42d010a3b9323cafe2e1a9989e9');
		expect(peer.userHash.slice(0, 34)).toBe('u_8f3df51a4c6d42335673ce516088c847');
		expect(derivedCardName(notes.userHash)).toBe('Ida');
	});

	it('are the same on every derivation, and distinct across families, notes and parents', () => {
		const notes = deriveNotesIdentity(account);
		expect(deriveNotesIdentity(account).userHash).toBe(notes.userHash);
		const peerA = deriveNotePeer(notes, NOTE_ID);
		const peerB = deriveNotePeer(notes, newNoteId());
		const hashes = new Set([
			userHashOf(accountSign.publicKey),
			notes.userHash,
			peerA.userHash,
			peerB.userHash,
			deriveIdentity(account, NOTE_PEER_SALT, hexToBytes(NOTE_ID)).userHash, // a peer salt under the account
		]);
		expect(hashes.size).toBe(5);
	});

	it('publish a card that verifies like any account\'s', () => {
		const notes = deriveNotesIdentity(account);
		const card = signedUserCard(notes, derivedCardName(notes.userHash), 1_700_000_000);
		const verdict = verifyUserCard(card);
		expect(verdict.status).toBe('verified');
		expect(secp.getPublicKey(notes.contactSkey, true)).toEqual(notes.contactPkey);
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
		expect(() => deriveNotePeer(account, 'note-1')).toThrow(/note id/);
	});
});

describe('a note', () => {
	it('is an ordinary dialog: the notes identity writes, re-derives its key, and the peer could unwrap it', async () => {
		const notes = deriveNotesIdentity(account);
		const peer = deriveNotePeer(notes, NOTE_ID);
		const key = deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, peer.userHash);
		expect(dialogHash(notes.userHash, peer.userHash)).toMatch(/^di_[0-9a-f]{128}$/);

		const wrapped = await wrapSenderMsgKey(key, peer.cryptPkey);
		expect(await unwrapSenderMsgKey(peer.cryptSkey, wrapped.peer_kem_wrap_key_b64, wrapped.peer_wrapped_msg_key_b64)).toEqual(key);

		const content = await encryptContent(key, '"buy milk"');
		const again = deriveNotesIdentity(account); // another device
		expect(await decryptContent(deriveSenderMsgKey(again.signSkey, again.cryptSkey, peer.userHash), content)).toBe('"buy milk"');
	});

	it('has a key of its own', () => {
		const notes = deriveNotesIdentity(account);
		const a = deriveNotePeer(notes, NOTE_ID);
		const b = deriveNotePeer(notes, newNoteId());
		expect(deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, a.userHash))
			.not.toEqual(deriveSenderMsgKey(notes.signSkey, notes.cryptSkey, b.userHash));
	});
});
