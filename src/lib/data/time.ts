// Monotonic owner_timestamp for revisions of the same entity.
//
// The backend orders revisions by owner_timestamp (a stale edit must not
// overwrite a newer tip), so two operations inside the same wall-clock second
// must still produce strictly increasing values: an edit right after a send,
// a reaction toggled twice, a quick profile double-save.
export const nextOwnerTimestamp = (previous?: number | null): number => {
	const now = Math.floor(Date.now() / 1000);
	return Math.max(now, Number(previous || 0) + 1);
};
