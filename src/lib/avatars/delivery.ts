// Delivery of the owner's gallery into dialogs (pq_avatars § Delivery).
//
// 1. On a change — a photo added, removed or set as main — one message with
//    the one part, into every dialog the account has.
// 2. On a new dialog — the first time this account sends in a dialog that
//    has no `avatar` part from it — one message with the whole gallery,
//    oldest first.
//
// "Every dialog the account has" is the account's contacts it has sent to
// (its own dialog key exists there): a contact it never wrote to is reached
// by rule 2 at the first message, and people who are not contacts get no
// photo at all. A dialog that carries no avatar part from this account yet
// gets the whole gallery even on a change, since one part alone would leave
// it with a gallery of one.
//
// Whether a dialog carries an avatar part is read from it every time, its
// messages still on their way included (dialogs.store ownDialogCarriesAvatar);
// deliveries into one dialog run one at a time, so a second one sees what the
// first stored. A snapshot sent twice anyway is harmless — applying it
// reproduces the same order.

import { isAvatarPart, type AvatarPart, type AvatarRemovedPart, type ContentPart } from '@/lib/pq/content';
import { serialized } from '@/lib/data/serialized';
import { snapshotParts, type GalleryEntry } from './gallery';

export type AvatarChange = AvatarPart | AvatarRemovedPart;

/** What a dialog says about this account; null where it could not be read. */
export interface DialogProbe {
	/** This account has sent in the dialog: its own key is there. Not read unless asked for. */
	ownKey?: boolean | null;
	/** This account's messages there carry an `avatar` part. Not read when ownKey was asked for and is not true. */
	carries: boolean | null;
}

export interface DeliveryDeps {
	/** The owner's gallery after the change, newest first. */
	gallery(): Promise<GalleryEntry[]>;
	/** The peers a change may go to: the account's contacts. */
	contacts(): string[];
	/** Whether a send to this peer may carry the gallery at all (a contact). */
	isTarget(peerHash: string): boolean;
	/** One read of the dialog with a peer. */
	probe(peerHash: string, opts: { requireOwnKey: boolean }): Promise<DialogProbe>;
	/** Stores the message durably for sending (the dialog outbox). */
	send(peerHash: string, parts: ContentPart[]): Promise<void>;
	now?(): number;
}

/** Dialogs probed at once on a change: enough to overlap the reads, few enough not to open every shape together. */
export const PROBE_CONCURRENCY = 4;

/** How long a dialog found without this account's key is skipped by the next changes. */
export const NO_KEY_TTL_MS = 60_000;

/**
 * The message a change becomes in one dialog. Where the dialog already
 * carries this account's gallery it is the change alone; elsewhere it is the
 * gallery after the change. A dialog that could not be read also gets a
 * removal after the gallery, for a reader who had the photo from a message
 * this device could not see.
 */
export const changeMessage = (change: AvatarChange, gallery: GalleryEntry[], carries: boolean | null): ContentPart[] => {
	if (carries === true) return [change];
	const snapshot: ContentPart[] = snapshotParts(gallery);
	return carries === null && change.kind === 'avatar_removed' ? [...snapshot, change] : snapshot;
};

/** Runs `fn` over `items`, at most `limit` at a time. */
const eachLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

export type FirstSendOutcome = 'skipped' | 'empty' | 'present' | 'unknown' | 'sent';

export interface DeliveryResult {
	sent: string[];
	failed: { peerHash: string; error: unknown }[];
}

export const createAvatarDelivery = (deps: DeliveryDeps) => {
	const now = deps.now ?? Date.now;
	const queues = new Map<string, Promise<unknown>>();
	const perPeer = <T>(peerHash: string, fn: () => Promise<T>) => serialized(queues, peerHash, fn);
	// Contacts found without this account's key: each change would read their
	// dialogs again for the same answer, until the account writes there.
	const noKeyUntil = new Map<string, number>();

	/** Rule 1: sends a change into every dialog the account has. */
	const deliverChange = async (change: AvatarChange): Promise<DeliveryResult> => {
		const result: DeliveryResult = { sent: [], failed: [] };
		const gallery = await deps.gallery();
		const peers = deps.contacts().filter((p) => !((noKeyUntil.get(p) ?? 0) > now()));
		await eachLimit(peers, PROBE_CONCURRENCY, (peerHash) => perPeer(peerHash, async () => {
			const { ownKey, carries } = await deps.probe(peerHash, { requireOwnKey: true });
			if (ownKey !== true) {
				if (ownKey === false) noKeyUntil.set(peerHash, now() + NO_KEY_TTL_MS);
				return;
			}
			const parts = changeMessage(change, gallery, carries);
			if (!parts.length) return;
			await deps.send(peerHash, parts);
			result.sent.push(peerHash);
		}).catch((error) => { result.failed.push({ peerHash, error }); }));
		return result;
	};

	/**
	 * Rule 2, called after this account stored a message for a dialog: the
	 * gallery follows it when the dialog carries no avatar part from it yet.
	 * Its own avatar messages never trigger it, which keeps it from looping.
	 */
	const onOwnSend = async (peerHash: string, parts: ContentPart[]): Promise<FirstSendOutcome> => {
		if (parts.some(isAvatarPart) || !deps.isTarget(peerHash)) return 'skipped';
		noKeyUntil.delete(peerHash);
		// No photo, nothing to read the dialog for.
		if (!(await deps.gallery()).length) return 'empty';
		return perPeer(peerHash, async () => {
			const { carries } = await deps.probe(peerHash, { requireOwnKey: false });
			if (carries === true) return 'present';
			// Unread is not absent: try again at the next message rather than guess.
			if (carries === null) return 'unknown';
			const gallery = await deps.gallery();
			if (!gallery.length) return 'empty';
			await deps.send(peerHash, snapshotParts(gallery));
			return 'sent';
		});
	};

	return { deliverChange, onOwnSend };
};
