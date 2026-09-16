// Unsent input, kept per dialog so a reload, a dialog switch or a crash does
// not eat what the user was typing. Purely local — a draft never syncs.
//
// Encrypted from the first keystroke: this rides localStore, whose values are
// AES-GCM under the account key and whose key names are HMAC-derived, so
// neither the draft text nor which dialog it was for is readable outside the
// writing account. There is no plaintext-then-encrypt phase to defer — one
// GCM of a short string per debounced save is free.
import { kvGet, kvSet, kvDelete } from './localStore';

export interface Draft {
	text: string;
	/** ChatWindow's reply context, JSON-serializable; the quote being answered
	 * is part of what the user was composing. */
	replyTo: unknown | null;
	savedAt: number;
}

const draftKey = (userHash: string, peerHash: string) => `draft|${userHash}|${peerHash}`;

/** Null when there is no draft — or when it is not readable right now (vault
 * locked, another account's record): unreadable must never become "gone". */
export const loadDraft = async (userHash: string, peerHash: string): Promise<Draft | null> => {
	if (!userHash || !peerHash) return null;
	try {
		return (await kvGet<Draft>(draftKey(userHash, peerHash))) ?? null;
	} catch {
		return null;
	}
};

/** An empty draft deletes the record — leaving ciphertext behind for cleared
 * input would make every dialog look like it holds something. */
export const saveDraft = async (userHash: string, peerHash: string, draft: Draft): Promise<void> => {
	if (!userHash || !peerHash) return;
	try {
		if (!draft.text.trim() && !draft.replyTo) await kvDelete(draftKey(userHash, peerHash));
		else await kvSet(draftKey(userHash, peerHash), draft);
	} catch (e) {
		// A failed save loses at most one debounce window of typing; the input
		// itself still holds the text.
		console.warn('[drafts] save failed:', e);
	}
};

export const clearDraft = async (userHash: string, peerHash: string): Promise<void> => {
	if (!userHash || !peerHash) return;
	await kvDelete(draftKey(userHash, peerHash)).catch((e) => console.warn('[drafts] clear failed:', e));
};
