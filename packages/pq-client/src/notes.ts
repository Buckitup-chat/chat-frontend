// Notes to self (chat/docs/pq/reqs/pq_notes_to_self.proposed.md).
//
// An account keeps its notes as dialogs of a notes identity derived from its
// own keys, so the server cannot tie the notes to it. Each note is a dialog
// between the notes identity and a note peer derived from the notes identity
// and the note's id: one identity has only one dialog with itself.
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { deriveIdentity, type DerivedIdentity, type ParentKeys } from './derivedIdentity.js';

export const NOTES_IDENTITY_SALT = 'buckitup/notes-identity/v1';
export const NOTE_PEER_SALT = 'buckitup/notes-peer/v1';

/** The User Storage slot of the account that lists its notes by id. */
export const NOTES_SLOT = 'notes';

const NOTE_ID = /^[0-9a-f]{32}$/;

/** 16 random bytes, hex: random rather than counted, so two offline devices never mint the same note. */
export const newNoteId = (): string => bytesToHex(randomBytes(16));

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && NOTE_ID.test(v);

/** The account's notes identity: the same on every device that holds the account's keys. */
export const deriveNotesIdentity = (account: ParentKeys): DerivedIdentity =>
	deriveIdentity(account, NOTES_IDENTITY_SALT);

/** The peer of note `noteId`. Its keys only ever sign its card. */
export const deriveNotePeer = (notes: ParentKeys, noteId: string): DerivedIdentity => {
	if (!isNoteId(noteId)) throw new Error('note id: 32 lowercase hex characters');
	return deriveIdentity(notes, NOTE_PEER_SALT, hexToBytes(noteId));
};

// Card names must be non-empty and are public. A derived identity takes a
// common given name, chosen by its own key so that every device publishes the
// same card, rather than anything that marks it as a notes identity.
const NAMES = [
	'Alex', 'Anna', 'Ari', 'Ben', 'Cami', 'Chris', 'Dana', 'Dani',
	'Eli', 'Ella', 'Emil', 'Eva', 'Felix', 'Finn', 'Gabi', 'Hana',
	'Ian', 'Ida', 'Ilya', 'Ivan', 'Jade', 'Jan', 'Jona', 'Kai',
	'Kim', 'Lara', 'Lea', 'Leo', 'Lina', 'Luca', 'Maja', 'Max',
	'Maya', 'Mia', 'Mila', 'Nadia', 'Nico', 'Nina', 'Noa', 'Ola',
	'Oleg', 'Omar', 'Pau', 'Petra', 'Rafa', 'Remi', 'Rita', 'Robin',
	'Rosa', 'Sam', 'Sara', 'Sasha', 'Simon', 'Sofia', 'Tara', 'Teo',
	'Tom', 'Uma', 'Vera', 'Viktor', 'Yara', 'Yuri', 'Zoe', 'Zora',
];

/** The public card name of a derived identity: a given name picked by its user_hash. */
export const derivedCardName = (userHash: string): string =>
	NAMES[sha3_256(new TextEncoder().encode(userHash))[0] % NAMES.length];
