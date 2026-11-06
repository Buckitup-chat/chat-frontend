// The identities a session signs as besides its account.
//
// An account may write as identities derived from its own keys: its notes
// identity and the peers of its notes (chat: pq_notes_to_self.proposed.md),
// later the subaccounts of pq_subaccounts.proposed.md. The server checks every
// request's proof of possession against the author of its rows, so each write
// is proven by the identity that signed it, never by the account for another.
//
// Such a write is the account's record: it queues and replays in the account's
// outbox, which stores with it which derived identity signs it (a
// DerivedSigner, never a key). Whichever tab of the account sends it derives
// that identity's key from the account's keys then.
import { VaultLockedError } from './keyCustody';
import { isNoteId } from '@buckitup/pq-client/notes';

/** Which identity derived from the account signs a write. */
export type DerivedSigner = { kind: 'notes' } | { kind: 'note-peer'; noteId: string };

export const isDerivedSigner = (v: unknown): v is DerivedSigner => {
	if (!v || typeof v !== 'object') return false;
	const s = v as { kind?: unknown; noteId?: unknown };
	if (s.kind === 'notes') return Object.keys(s).length === 1;
	return s.kind === 'note-peer' && isNoteId(s.noteId) && Object.keys(s).length === 2;
};

export interface ResolvedSigner {
	userHash: string;
	/** A fresh copy of the identity's signing key, which the caller wipes after use. */
	signingKey: () => Promise<Uint8Array>;
}

type Resolve = (signer: DerivedSigner) => ResolvedSigner;

let session: { account: string; resolve: Resolve } | null = null;

/** `account`'s session derives its identities with `resolve` until it ends. */
export function holdSessionIdentities(account: string, resolve: Resolve): void {
	session = { account, resolve };
}

export function releaseSessionIdentities(): void {
	session = null;
}

const locked = (account: string) => new VaultLockedError(`the keys of ${account} are not open on this device`);

/** The account whose session is open; VaultLockedError when none is. */
export function sessionAccount(): string {
	if (!session) throw new VaultLockedError('no account is open on this device');
	return session.account;
}

/** The identity `signer` names under `account`; VaultLockedError unless `account`'s session is open. */
export function derivedSigner(account: string, signer: DerivedSigner): ResolvedSigner {
	if (session?.account !== account) throw locked(account);
	return session.resolve(signer);
}
