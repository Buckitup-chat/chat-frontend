// Per-dialog checkpoint pointers, kept so the dialogs list can flag what
// changed without re-reading every dialog from scratch.
//
// A checkpoint attests a state the user confirmed; the alert answers "has the
// dialog moved since". Answering it needs the newest checkpoint the user
// signed in that dialog, which is buried in encrypted content — so the scan
// that finds it records what it learned here: the checkpoint itself, and how
// far the scan already looked. A later scan then only has to decrypt messages
// newer than that mark, and dialogs that never had a checkpoint stop being
// re-read message by message on every visit.
//
// Stored through localStore, so the record is AES-GCM encrypted under the
// account key and its key name is derived — another account sharing the
// browser profile learns neither the pointer nor which dialog it belongs to.
import { kvGet, kvSet } from './localStore';
import { buildViewTree } from '@/lib/pq/checkpoint';

export interface CheckpointPointer {
	/** Newest checkpoint this user signed in the dialog; null = none found. */
	checkpoint: {
		messageId: string;
		viewRoot: string;
		frontierRoot: string;
		createdAt: number;
	} | null;
	/**
	 * Feed-order key of the newest message the scan has already decoded. Older
	 * messages cannot hold a newer checkpoint, so the next scan skips them.
	 */
	scannedTo: number;
}

const EMPTY: CheckpointPointer = { checkpoint: null, scannedTo: 0 };

const key = (userHash: string, dialogHash: string) => `cpptr|${userHash}|${dialogHash}`;

export const loadPointer = async (userHash: string, dialogHash: string): Promise<CheckpointPointer> => {
	if (!userHash || !dialogHash) return EMPTY;
	try {
		return (await kvGet<CheckpointPointer>(key(userHash, dialogHash))) ?? EMPTY;
	} catch {
		// Locked vault or another account's record: treat as "nothing known"
		// rather than failing the dialogs list.
		return EMPTY;
	}
};

export const savePointer = async (
	userHash: string,
	dialogHash: string,
	pointer: CheckpointPointer,
): Promise<void> => {
	if (!userHash || !dialogHash) return;
	try {
		await kvSet(key(userHash, dialogHash), pointer);
		// The sweep only visits indexed dialogs, so a pointer that carries a
		// checkpoint must register its dialog or no alert will ever fire there.
		if (pointer.checkpoint) await rememberPointerDialog(userHash, dialogHash);
	} catch (e) {
		// The pointer is a cache: losing it costs a rescan, nothing more.
		console.warn('[checkpointAlerts] pointer save failed:', e);
	}
};

/** Row shape the alert needs; the full row carries much more. */
export interface AlertRow {
	message_id: string;
	sign_hash: string;
	deleted_flag?: boolean | number | null;
}

/**
 * The dialog's view as stored, without consulting the receive gate.
 *
 * A checkpoint can only be signed when every row is admitted, so at signing
 * time the raw and verified views are the same set; afterwards the raw view is
 * the stabler of the two, since it does not flicker while author cards sync.
 * A row that later fails verification still counts as a change — something
 * happened in that dialog worth looking at.
 */
export const rawViewState = (
	rows: AlertRow[],
	excludeMessageId?: string,
): Record<string, { signHash: string; deleted: boolean }> => {
	const state: Record<string, { signHash: string; deleted: boolean }> = {};
	for (const row of rows) {
		if (row.message_id === excludeMessageId) continue;
		state[row.message_id] = { signHash: row.sign_hash, deleted: !!row.deleted_flag };
	}
	return state;
};

/**
 * Whether the dialog shows something other than what the checkpoint fixed.
 *
 * Compares view roots, not frontiers: history that changed without changing
 * what is displayed — an edit undone by a later edit, a losing fork — is not
 * worth a notification.
 *
 * The message carrying the checkpoint is excluded: it did not exist when the
 * root was computed, so counting it would make every checkpoint report its
 * own arrival as a change.
 */
export const viewMoved = (
	rows: AlertRow[],
	checkpointViewRoot: string,
	carrierMessageId?: string,
): boolean => buildViewTree(rawViewState(rows, carrierMessageId)).root !== checkpointViewRoot;

// ---------- which dialogs are worth sweeping ----------
//
// The dialogs list knows every replicated user card — on a shared backend
// that is hundreds of strangers, and sweeping them all means opening
// hundreds of cold shapes to learn that nothing was ever confirmed there.
// A checkpoint pointer only comes into existence through this account's own
// signing (or a scan that found one), so an index of dialogs that HAVE a
// pointer bounds the sweep to dialogs where an alert is even possible.
//
// Record keys in localStore are HMAC-derived, so the pointer records cannot
// be enumerated — the index is its own record. A checkpoint signed by this
// account on another device is not in this index until a dialog visit finds
// it; that is the trade until multi-device sync of local state exists.

const indexKey = (userHash: string) => `cpptr-index|${userHash}`;

export const pointerDialogs = async (userHash: string): Promise<Set<string>> => {
	if (!userHash) return new Set();
	try {
		return new Set((await kvGet<string[]>(indexKey(userHash))) ?? []);
	} catch {
		return new Set();
	}
};

export const rememberPointerDialog = async (userHash: string, dialogHash: string): Promise<void> => {
	if (!userHash || !dialogHash) return;
	try {
		const dialogs = await pointerDialogs(userHash);
		if (dialogs.has(dialogHash)) return;
		dialogs.add(dialogHash);
		await kvSet(indexKey(userHash), [...dialogs]);
	} catch (e) {
		console.warn('[checkpointAlerts] pointer index update failed:', e);
	}
};
