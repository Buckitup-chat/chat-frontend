import { validate as validateUuid, version as uuidVersion } from "uuid";
import type { DialogMessageFields, DialogReactionFields } from "./dialogQueue";

export function preferAckedCache<A, B>(network: A | null | undefined, cached: B | null | undefined): A | B | null | undefined {
	if (!network) return cached;
	if (!cached) return network;
	return (cached as { __awaitingEcho?: boolean }).__awaitingEcho ? cached : network;
}

export function getDialogMessageCreatedAtMs(messageId: unknown): number | null {
	if (typeof messageId !== "string" || !messageId.startsWith("dmsg_")) {
		return null;
	}

	const uuid = messageId.slice(5);

	if (!validateUuid(uuid) || uuidVersion(uuid) !== 7) {
		return null;
	}

	const timestampHex = uuid.slice(0, 8) + uuid.slice(9, 13);
	const timestampMs = Number.parseInt(timestampHex, 16);

	return Number.isSafeInteger(timestampMs)
		? timestampMs
		: null;
}

type DisplayOrderableRow = {
	id?: string;
	message_id?: string;
	owner_timestamp?: unknown;
	ownerTimestamp?: unknown;
	_raw?: { message_id?: string; owner_timestamp?: unknown };
};

function displayMessageId(row: DisplayOrderableRow): string {
	return String(row.message_id ?? row._raw?.message_id ?? row.id ?? "");
}

function displayOwnerTimestamp(row: DisplayOrderableRow): unknown {
	return row._raw?.owner_timestamp ?? row.owner_timestamp ?? row.ownerTimestamp ?? 0;
}

function displayTimeMs(row: DisplayOrderableRow): number {
	const createdAtMs = getDialogMessageCreatedAtMs(displayMessageId(row));
	if (createdAtMs !== null) return createdAtMs;
	return Number(displayOwnerTimestamp(row)) * 1000;
}

export function compareByOwnerTimestamp(a: DisplayOrderableRow, b: DisplayOrderableRow): number {
	const diff = displayTimeMs(a) - displayTimeMs(b);
	if (diff !== 0) return diff;

	const aId = displayMessageId(a);
	const bId = displayMessageId(b);
	if (aId < bId) return -1;
	if (aId > bId) return 1;
	return 0;
}

export function getDialogMessageDisplayTimestamp(row: { message_id?: string; owner_timestamp?: unknown }): number {
	const createdAtMs = getDialogMessageCreatedAtMs(row.message_id);
	if (createdAtMs !== null) return createdAtMs / 1000;
	return Number(row.owner_timestamp ?? 0);
}

export function isDialogMessageEdited(row: { parent_sign_hash?: unknown } | null | undefined): boolean {
	return Boolean(row?.parent_sign_hash);
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
		.sort(compareByOwnerTimestamp);
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

export function formatMessageTime(ownerTimestamp: unknown): string {
	const date = new Date(Number(ownerTimestamp ?? 0) * 1000);
	return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export function shouldRedecryptMessage(cachedEntry: { _contentB64?: string } | undefined, row: { content_b64?: string | null }): boolean {
	return !cachedEntry || cachedEntry._contentB64 !== row.content_b64;
}
