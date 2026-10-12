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
//
// Nothing owed is dropped. A change records every dialog it goes to before
// sending, and each leaves the record once its message is stored or it turns
// out to need none; a dialog that could not be read, or whose send failed,
// stays owed, as does one whose first message could not be checked. What is
// owed is sent when the app starts, when the connection returns, and at the
// next message into that dialog — as the whole gallery after the removals
// it missed, which leaves it right whatever it already had.

import { isAvatarPart, type AvatarPart, type AvatarRemovedPart, type ContentPart } from '@/lib/pq/content';
import { serialized } from '@/lib/data/serialized';
import { snapshotParts, type GalleryEntry } from './gallery';
import type { Owed, OwedMap } from './localStore';

export type AvatarChange = AvatarPart | AvatarRemovedPart;

/** What a dialog says about this account; null where it could not be read. */
export interface DialogProbe {
	/** This account has sent in the dialog: its own key is there. Not read unless asked for. */
	ownKey?: boolean | null;
	/** This account's messages there carry an `avatar` part. Not read when ownKey was asked for and is not true. */
	carries: boolean | null;
}

export interface DeliveryDeps {
	/** The owner's gallery, newest first; `fresh` reads it from the slot again, as another device may have changed it. */
	gallery(opts?: { fresh?: boolean }): Promise<GalleryEntry[]>;
	/** The peers a change may go to: the account's contacts. */
	contacts(): string[];
	/** Whether a send to this peer may carry the gallery at all (a contact). */
	isTarget(peerHash: string): boolean;
	/** One read of the dialog with a peer. */
	probe(peerHash: string, opts: { requireOwnKey: boolean }): Promise<DialogProbe>;
	/** Stores the message durably for sending (the dialog outbox). */
	send(peerHash: string, parts: ContentPart[]): Promise<void>;
	/** The dialogs owed a delivery, kept on the device (lib/avatars/localStore). */
	owed: {
		load(): Promise<OwedMap>;
		update(change: (owed: OwedMap) => void): Promise<unknown>;
	};
	now?(): number;
}

/** Dialogs probed at once: enough to overlap the reads, few enough not to open every shape together. */
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

/** What makes good what a dialog missed: the gallery as it is, then the removals of photos no longer in it. */
export const catchUpMessage = (gallery: GalleryEntry[], removed: string[] = []): ContentPart[] => {
	const kept = new Set(gallery.map((e) => e.avatarId));
	return [
		...snapshotParts(gallery),
		...[...new Set(removed)].filter((id) => !kept.has(id)).map((avatarId): ContentPart => ({ kind: 'avatar_removed', avatarId })),
	];
};

const owe = (owed: OwedMap, peerHash: string, entry: Owed) => {
	const prev = owed[peerHash] ?? {};
	owed[peerHash] = {
		change: prev.change || entry.change || undefined,
		first: prev.first || entry.first || undefined,
		removed: [...new Set([...(prev.removed ?? []), ...(entry.removed ?? [])])],
	};
};

/** Runs `fn` over `items`, at most `limit` at a time. */
const eachLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

export type FirstSendOutcome = 'skipped' | 'empty' | 'present' | 'unknown' | 'sent' | 'caught-up' | 'owed';

export interface DeliveryResult {
	/** Dialogs the message was stored for sending to. */
	sent: string[];
	/** Dialogs whose message could not be stored; still owed. */
	failed: { peerHash: string; error: unknown }[];
	/** Dialogs that could not be read; still owed, sent later. */
	pending: string[];
}

export const createAvatarDelivery = (deps: DeliveryDeps) => {
	const now = deps.now ?? Date.now;
	const queues = new Map<string, Promise<unknown>>();
	const perPeer = <T>(peerHash: string, fn: () => Promise<T>) => serialized(queues, peerHash, fn);
	// Contacts found without this account's key: each change would read their
	// dialogs again for the same answer, until the account writes there.
	const noKeyUntil = new Map<string, number>();
	const settle = (peerHash: string) => deps.owed.update((owed) => { delete owed[peerHash]; });

	/** Rule 1: sends a change into every dialog the account has. */
	const deliverChange = async (change: AvatarChange): Promise<DeliveryResult> => {
		const result: DeliveryResult = { sent: [], failed: [], pending: [] };
		const gallery = await deps.gallery();
		const peers = deps.contacts().filter((p) => !((noKeyUntil.get(p) ?? 0) > now()));
		// Owed before anything is sent: an interrupted delivery leaves the rest owed.
		let earlier: OwedMap = {};
		await deps.owed.update((owed) => {
			earlier = structuredClone(owed);
			for (const peer of peers) owe(owed, peer, { change: true, removed: change.kind === 'avatar_removed' ? [change.avatarId] : [] });
		});
		await eachLimit(peers, PROBE_CONCURRENCY, (peerHash) => perPeer(peerHash, async () => {
			const { ownKey, carries } = await deps.probe(peerHash, { requireOwnKey: true });
			if (ownKey === null) {
				result.pending.push(peerHash);
				return;
			}
			if (ownKey !== true) {
				noKeyUntil.set(peerHash, now() + NO_KEY_TTL_MS);
				await settle(peerHash);
				return;
			}
			// A dialog that missed earlier changes is caught up whole.
			const missed = earlier[peerHash];
			const parts = missed
				? catchUpMessage(gallery, [...(missed.removed ?? []), ...(change.kind === 'avatar_removed' ? [change.avatarId] : [])])
				: changeMessage(change, gallery, carries);
			if (parts.length) {
				await deps.send(peerHash, parts);
				result.sent.push(peerHash);
			}
			await settle(peerHash);
		}).catch((error) => { result.failed.push({ peerHash, error }); }));
		return result;
	};

	/** Sends what one owed dialog is owed; resolves to whether it is settled. */
	const payOwed = async (peerHash: string, entry: Owed): Promise<'sent' | 'settled' | 'pending'> => {
		if (entry.change) {
			const { ownKey } = await deps.probe(peerHash, { requireOwnKey: true });
			if (ownKey === null) return 'pending';
			if (ownKey === true) {
				const parts = catchUpMessage(await deps.gallery({ fresh: true }), entry.removed);
				if (parts.length) {
					await deps.send(peerHash, parts);
					await settle(peerHash);
					return 'sent';
				}
			}
			await settle(peerHash);
			return 'settled';
		}
		const { carries } = await deps.probe(peerHash, { requireOwnKey: false });
		if (carries === null) return 'pending';
		const gallery = carries ? [] : await deps.gallery({ fresh: true });
		if (gallery.length) await deps.send(peerHash, snapshotParts(gallery));
		await settle(peerHash);
		return gallery.length ? 'sent' : 'settled';
	};

	/** Sends what is owed: to every owed contact, or to `only`. */
	const retryOwed = async (only: string[] | null = null): Promise<DeliveryResult> => {
		const result: DeliveryResult = { sent: [], failed: [], pending: [] };
		const owed = await deps.owed.load();
		// Not a contact now (or not yet: contacts load after sign-in): kept for later.
		const peers = Object.keys(owed).filter((p) => (only ? only.includes(p) : true) && deps.isTarget(p));
		await eachLimit(peers, PROBE_CONCURRENCY, (peerHash) => perPeer(peerHash, async () => {
			const outcome = await payOwed(peerHash, owed[peerHash]);
			if (outcome === 'sent') result.sent.push(peerHash);
			if (outcome === 'pending') result.pending.push(peerHash);
		}).catch((error) => { result.failed.push({ peerHash, error }); }));
		return result;
	};

	/**
	 * Rule 2, called after this account stored a message for a dialog: the
	 * gallery follows it when the dialog carries no avatar part from it yet,
	 * or what the dialog is owed when it is owed something. Its own avatar
	 * messages never trigger it, which keeps it from looping.
	 */
	const onOwnSend = async (peerHash: string, parts: ContentPart[]): Promise<FirstSendOutcome> => {
		if (parts.some(isAvatarPart) || !deps.isTarget(peerHash)) return 'skipped';
		noKeyUntil.delete(peerHash);
		if ((await deps.owed.load())[peerHash]) {
			const { sent, pending, failed } = await retryOwed([peerHash]);
			return sent.length ? 'caught-up' : pending.length || failed.length ? 'owed' : 'present';
		}
		// No photo, nothing to read the dialog for.
		if (!(await deps.gallery()).length) return 'empty';
		return perPeer(peerHash, async () => {
			const { carries } = await deps.probe(peerHash, { requireOwnKey: false });
			if (carries === true) return 'present';
			// Unread is not absent: owed, and sent once the dialog can be read.
			if (carries === null) {
				await deps.owed.update((owed) => owe(owed, peerHash, { first: true }));
				return 'unknown';
			}
			// The gallery as it is now: a photo removed on another device must not go out.
			const gallery = await deps.gallery({ fresh: true });
			if (!gallery.length) return 'empty';
			try {
				await deps.send(peerHash, snapshotParts(gallery));
			} catch (e) {
				await deps.owed.update((owed) => owe(owed, peerHash, { first: true }));
				throw e;
			}
			return 'sent';
		});
	};

	return { deliverChange, onOwnSend, retryOwed };
};
