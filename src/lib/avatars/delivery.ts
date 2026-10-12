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
// Whether a dialog carries an avatar part is read from its messages once and
// then remembered per dialog (`mark`): the messages this device sends are
// not in the shape until they round-trip, and a second send in that window
// must not produce a second snapshot. A snapshot sent twice is harmless —
// applying it reproduces the same order — so the marker only spares noise.

import type { AvatarPart, AvatarRemovedPart, ContentPart } from '@/lib/pq/content';
import { snapshotParts, type GalleryEntry } from './gallery';

export type AvatarChange = AvatarPart | AvatarRemovedPart;

export interface DeliveryDeps {
	/** The owner's gallery after the change, newest first. */
	gallery(): Promise<GalleryEntry[]>;
	/** Peers a change goes to: the dialogs the account has. */
	targets(): Promise<string[]>;
	/** Whether a send to this peer may carry the gallery at all (a contact). */
	isTarget(peerHash: string): boolean;
	/** Whether this account's live messages in the dialog carry an `avatar` part; null when the dialog could not be read. */
	readCarries(peerHash: string): Promise<boolean | null>;
	marked(peerHash: string): boolean;
	mark(peerHash: string): void;
	/** Stores the message durably for sending (the dialog outbox). */
	send(peerHash: string, parts: ContentPart[]): Promise<void>;
}

const isAvatarPart = (p: ContentPart) => p.kind === 'avatar' || p.kind === 'avatar_removed';

/**
 * The message a change becomes in one dialog. Where the dialog already
 * carries this account's gallery it is the change alone; elsewhere it is the
 * gallery after the change, with a removal kept at the end for a reader who
 * had the photo from a message this device could not see.
 */
export const changeMessage = (change: AvatarChange, gallery: GalleryEntry[], carries: boolean | null): ContentPart[] =>
	carries === true
		? [change]
		: [...snapshotParts(gallery), ...(change.kind === 'avatar_removed' ? [change] : [])];

export type FirstSendOutcome = 'skipped' | 'present' | 'unknown' | 'empty' | 'sent';

export interface DeliveryResult {
	sent: string[];
	failed: { peerHash: string; error: unknown }[];
}

export const createAvatarDelivery = (deps: DeliveryDeps) => {
	// One delivery per dialog at a time: a change and a first message racing
	// in the same dialog would otherwise both find it unmarked.
	const queues = new Map<string, Promise<unknown>>();
	const perPeer = <T>(peerHash: string, fn: () => Promise<T>): Promise<T> => {
		const run = (queues.get(peerHash) ?? Promise.resolve()).then(fn, fn);
		const settled = run.catch(() => undefined);
		queues.set(peerHash, settled);
		void settled.then(() => { if (queues.get(peerHash) === settled) queues.delete(peerHash); });
		return run;
	};

	const carries = async (peerHash: string): Promise<boolean | null> => {
		if (deps.marked(peerHash)) return true;
		const read = await deps.readCarries(peerHash);
		if (read === true) deps.mark(peerHash);
		return read;
	};

	/** Rule 1: sends a change into every dialog the account has. */
	const deliverChange = async (change: AvatarChange): Promise<DeliveryResult> => {
		const result: DeliveryResult = { sent: [], failed: [] };
		const gallery = await deps.gallery();
		for (const peerHash of await deps.targets()) {
			try {
				await perPeer(peerHash, async () => {
					const parts = changeMessage(change, gallery, await carries(peerHash));
					if (!parts.length) return;
					await deps.send(peerHash, parts);
					// A removal alone does not put an avatar part into the dialog.
					if (parts.some((p) => p.kind === 'avatar')) deps.mark(peerHash);
					result.sent.push(peerHash);
				});
			} catch (error) {
				result.failed.push({ peerHash, error });
			}
		}
		return result;
	};

	/**
	 * Rule 2, called after this account stored a message for a dialog: the
	 * gallery follows it when the dialog carries no avatar part from it yet.
	 * Its own avatar messages never trigger it, which keeps it from looping.
	 */
	const onOwnSend = (peerHash: string, parts: ContentPart[]): Promise<FirstSendOutcome> => {
		if (parts.some(isAvatarPart) || !deps.isTarget(peerHash)) return Promise.resolve('skipped');
		if (deps.marked(peerHash)) return Promise.resolve('present');
		return perPeer(peerHash, async () => {
			const known = await carries(peerHash);
			if (known === true) return 'present';
			// Unread is not absent: try again at the next message rather than guess.
			if (known === null) return 'unknown';
			const gallery = await deps.gallery();
			if (!gallery.length) return 'empty';
			await deps.send(peerHash, snapshotParts(gallery));
			deps.mark(peerHash);
			return 'sent';
		});
	};

	return { deliverChange, onOwnSend };
};
