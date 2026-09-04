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

/**
 * Milliseconds of the message's creation. Falls back to the row timestamp
 * (seconds) for anything that is not a dmsg_ UUIDv7 id.
 */
export const feedOrderKey = (id: string | undefined, fallbackTsSeconds: number): number => {
	const m = id ? DMSG.exec(id) : null;
	if (m) return parseInt(m[1] + m[2], 16);
	return (fallbackTsSeconds || 0) * 1000;
};
