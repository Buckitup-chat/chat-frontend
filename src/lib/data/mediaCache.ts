// Decrypted media cache, keyed by fileId.
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

export const getCachedMedia = (fileId: string): string | null => {
	const hit = entries.get(fileId);
	if (!hit) return null;
	// re-insert to refresh the LRU position
	entries.delete(fileId);
	entries.set(fileId, hit);
	return hit.url;
};

export const putCachedMedia = (fileId: string, bytes: Uint8Array, mimeType: string): string => {
	const existing = entries.get(fileId);
	if (existing) return existing.url;

	const url = URL.createObjectURL(new Blob([bytes as unknown as globalThis.BlobPart], { type: mimeType }));
	entries.set(fileId, { url, size: bytes.length });
	totalBytes += bytes.length;

	for (const [key, entry] of entries) {
		if (totalBytes <= MAX_BYTES || key === fileId) break;
		URL.revokeObjectURL(entry.url);
		entries.delete(key);
		totalBytes -= entry.size;
	}
	return url;
};
