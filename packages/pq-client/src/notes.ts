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

/** 16 random bytes, hex: random rather than counted, so two offline devices never mint the same note. */
export const newNoteId = (): string => bytesToHex(randomBytes(16));

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && NOTE_ID.test(v);

/** The account's notes identity: the same on every device that holds the account's keys. */
export const deriveNotesIdentity = (account: ParentKeys): DerivedIdentity =>
	deriveIdentity(account, NOTES_IDENTITY_SALT);

export interface NotePeers {
	/** What reading and writing a note need: its dialog_hash and message key come from it. */
	userHash(noteId: string): string;
	/** Every key; only creating a note (its card, the first key wrap) needs them. */
	identity(noteId: string): DerivedIdentity;
}

/** The peers of the notes under one notes identity; hold one for many notes. */
export const notePeers = (notes: ParentKeys): NotePeers => {
	const family = identityFamily(notes, NOTE_PEER_SALT);
	const prefix = (noteId: string) => {
		if (!isNoteId(noteId)) throw new Error('note id: 32 lowercase hex characters');
		return hexToBytes(noteId);
	};
	return {
		userHash: (noteId) => family.userHash(prefix(noteId)),
		identity: (noteId) => family.identity(prefix(noteId)),
	};
};
