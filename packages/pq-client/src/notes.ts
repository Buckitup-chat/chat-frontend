// Notes to self (chat/docs/pq/reqs/pq_notes_to_self.proposed.md).
//
// An account keeps its notes as dialogs of a notes identity derived from its
// own keys, so the server cannot tie the notes to it. Each note is a dialog
// between the notes identity and a note peer derived from the notes identity
// and the note's id: one identity has only one dialog with itself.
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { deriveIdentity, identityFamily, type DerivedIdentity, type ParentKeys } from './derivedIdentity.js';

export const NOTES_IDENTITY_SALT = 'buckitup/notes-identity/v1';
export const NOTE_PEER_SALT = 'buckitup/notes-peer/v1';

const NOTE_ID = /^[0-9a-f]{32}$/;

/** 16 random bytes in lowercase hex: random rather than counted, so two offline devices never mint the same note. */
export const newNoteId = (): string => bytesToHex(randomBytes(16));

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && NOTE_ID.test(v);

export interface AccountNotes {
	/** The notes identity: the author of every note. */
	identity: DerivedIdentity;
	/** A note peer's user_hash: what reading and writing the note need (its dialog_hash, its message key). */
	peerHash(noteId: string): string;
	/** Every key of a note peer; only creating the note (its card, the key wrap) needs them. */
	peer(noteId: string): DerivedIdentity;
	/** A note peer's signing secret key alone, a fresh copy the caller wipes after use. */
	peerSignSkey(noteId: string): Uint8Array;
	/** Wipes the notes identity's secret keys and what derives the peers: nothing more is derived. */
	wipe(): void;
}

/**
 * The notes of an account, from the account's own keys: the same on every
 * device that holds them. Hold one per session; peer hashes are cached.
 */
export const accountNotes = (account: ParentKeys): AccountNotes => {
	const identity = deriveIdentity(account, NOTES_IDENTITY_SALT);
	const peers = identityFamily(identity, NOTE_PEER_SALT);
	const hashes = new Map<string, string>();
	const prefix = (noteId: string) => {
		if (!isNoteId(noteId)) throw new Error('note id: 32 lowercase hex characters');
		return hexToBytes(noteId);
	};
	return {
		identity,
		peerHash(noteId) {
			let hash = hashes.get(noteId);
			if (!hash) {
				hash = peers.userHash(prefix(noteId));
				hashes.set(noteId, hash);
			}
			return hash;
		},
		peer: (noteId) => peers.identity(prefix(noteId)),
		peerSignSkey: (noteId) => peers.signSkey(prefix(noteId)),
		wipe() {
			peers.wipe();
			for (const key of [identity.signSkey, identity.cryptSkey, identity.contactSkey]) key.fill(0);
			hashes.clear();
		},
	};
};
