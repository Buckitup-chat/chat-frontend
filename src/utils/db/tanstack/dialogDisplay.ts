import type { DialogMessageFields, DialogReactionFields } from "./dialogQueue";

export function preferAckedCache<A, B>(network: A | null | undefined, cached: B | null | undefined): A | B | null | undefined {
	if (!network) return cached;
	if (!cached) return network;
	return (cached as { __awaitingEcho?: boolean }).__awaitingEcho ? cached : network;
}

export function mergeDialogMessagesForDisplay<T extends DialogMessageFields>(
	cached: T[] | null | undefined,
	network: T[] | null | undefined,
	pending: T[] | null | undefined,
	dialogHash: string | null | undefined
): T[] {
	const byId = new Map<string, T>();
	for (const row of cached || []) byId.set(row.message_id, row);
	for (const row of network || []) {
		const existing = byId.get(row.message_id);
		byId.set(row.message_id, (existing ? preferAckedCache(row, existing) : row) as T);
	}
	for (const row of pending || []) byId.set(row.message_id, row);

	return Array.from(byId.values())
		.filter((row) => row.dialog_hash === dialogHash && row.deleted_flag === false)
		.sort((a, b) => (Number(a.owner_timestamp) || 0) - (Number(b.owner_timestamp) || 0));
}

export function mergeDialogReactionsForDisplay<T extends DialogReactionFields>(
	cached: T[] | null | undefined,
	network: T[] | null | undefined,
	pending: T[] | null | undefined,
	dialogHash: string | null | undefined
): T[] {
	const byHash = new Map<string, T>();
	for (const row of cached || []) byHash.set(row.reaction_hash, row);
	for (const row of network || []) {
		const existing = byHash.get(row.reaction_hash);
		byHash.set(row.reaction_hash, (existing ? preferAckedCache(row, existing) : row) as T);
	}
	for (const row of pending || []) byHash.set(row.reaction_hash, row);

	return Array.from(byHash.values()).filter((row) => row.dialog_hash === dialogHash && row.deleted_flag === false);
}

export function isDialogMessagePending(messageId: string, pending: DialogMessageFields[] | null | undefined): boolean {
	return (pending || []).some((r) => r.message_id === messageId);
}

export function compareByOwnerTimestamp(
	a: { id?: string; message_id?: string; _raw?: { owner_timestamp?: unknown }; ownerTimestamp?: unknown },
	b: { id?: string; message_id?: string; _raw?: { owner_timestamp?: unknown }; ownerTimestamp?: unknown }
): number {
	const aTs = Number(a._raw?.owner_timestamp ?? a.ownerTimestamp ?? 0);
	const bTs = Number(b._raw?.owner_timestamp ?? b.ownerTimestamp ?? 0);
	const timeDiff = aTs - bTs;
	if (timeDiff !== 0) return timeDiff;

	const aId = String(a.message_id ?? a.id ?? "");
	const bId = String(b.message_id ?? b.id ?? "");
	return aId.localeCompare(bId);
}

export function formatMessageTime(ownerTimestamp: unknown): string {
	const date = new Date(Number(ownerTimestamp ?? 0) * 1000);
	return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export function shouldRedecryptMessage(cachedEntry: { _contentB64?: string } | undefined, row: { content_b64?: string | null }): boolean {
	return !cachedEntry || cachedEntry._contentB64 !== row.content_b64;
}
