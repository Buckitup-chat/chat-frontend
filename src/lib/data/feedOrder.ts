// Display order for the message feed.
//
// The feed orders by AUTHORING time, and owner_timestamp is not that: it is
// the revision counter — an edit must raise it or the server rejects the new
// revision, so sorting by it teleports every edited message to the end of
// the feed. The authoring moment lives in message_id: it is a UUIDv7, whose
// first 48 bits are the unix milliseconds of creation, fixed for the
// message's whole life (chat docs: 04_ordering.md names UUIDv7 the display
// order). Optimistic entries carry the same dmsg_ id they will be written
// under, so one key covers both.

const DMSG = /^dmsg_([0-9a-f]{8})-([0-9a-f]{4})/;

const uuidMs = (id: string | undefined): number | null => {
	const m = id ? DMSG.exec(id) : null;
	return m ? parseInt(m[1] + m[2], 16) : null;
};

/**
 * Milliseconds of the message's creation. Falls back to the row timestamp
 * (seconds) for anything that is not a dmsg_ UUIDv7 id.
 */
export const feedOrderKey = (id: string | undefined, fallbackTsSeconds: number): number =>
	uuidMs(id) ?? (fallbackTsSeconds || 0) * 1000;

/**
 * Comparator in feed order. Messages written within one millisecond share
 * the key; between two dmsg_ ids the full id breaks the tie, because a
 * UUIDv7 counts up inside the millisecond. Messages sent from one tab keep
 * the order they were written in, and every client resolves a tie the same
 * way. Any other tie stays 0, so a stable sort keeps the input order.
 */
export const compareFeedOrder = (aId: string | undefined, aTs: number, bId: string | undefined, bTs: number): number => {
	const a = uuidMs(aId);
	const b = uuidMs(bId);
	const byKey = (a ?? (aTs || 0) * 1000) - (b ?? (bTs || 0) * 1000);
	if (byKey || a === null || b === null || aId === bId) return byKey;
	return aId! < bId! ? -1 : 1;
};
