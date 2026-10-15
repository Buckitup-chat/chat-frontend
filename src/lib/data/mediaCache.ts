// Decrypted media cache, keyed by fileKey (fileKey.ts): the same file_id from
// another sender is another file, and must not be shown from here.
//
// Chunks are immutable and content-addressed, so a decrypted attachment never
// goes stale — re-downloading one because the user switched dialogs and came
// back is pure waste of the mesh's bandwidth. Entries live at module scope,
// across dialog switches and account views, bounded by total byte size with
// LRU eviction; evicting revokes the blob URL.
//
// Only the cache revokes its URLs: a consumer that revoked what it "owned"
// would break the same picture rendered elsewhere (the carousel, another
// visit to the dialog).

const MAX_BYTES = 120 * 1024 * 1024;

interface Entry {
	url: string;
	size: number;
}

const entries = new Map<string, Entry>(); // insertion order = LRU order
let totalBytes = 0;

export const getCachedMedia = (key: string): string | null => {
	const hit = entries.get(key);
	if (!hit) return null;
	// re-insert to refresh the LRU position
	entries.delete(key);
	entries.set(key, hit);
	return hit.url;
};

export const putCachedMedia = (key: string, bytes: Uint8Array, mimeType: string): string => {
	const existing = entries.get(key);
	if (existing) return existing.url;

	const url = URL.createObjectURL(new Blob([bytes as unknown as globalThis.BlobPart], { type: mimeType }));
	entries.set(key, { url, size: bytes.length });
	totalBytes += bytes.length;

	for (const [old, entry] of entries) {
		if (totalBytes <= MAX_BYTES || old === key) break;
		URL.revokeObjectURL(entry.url);
		entries.delete(old);
		totalBytes -= entry.size;
	}
	return url;
};
