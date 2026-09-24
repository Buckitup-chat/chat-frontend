import type { DialogCacheTable } from '@/lib/data/dialogCache';

type Row = Record<string, unknown>;

const TABLES: DialogCacheTable[] = ['dialog_keys', 'dialog_messages', 'dialog_messages_versions', 'dialog_message_reactions', 'dialog_message_receipts'];
const mainKey: Record<DialogCacheTable, (r: Row) => string> = {
	dialog_keys: (r) => `${r.dialog_hash}:${r.sender_hash}`,
	dialog_messages: (r) => r.message_id as string,
	dialog_messages_versions: (r) => `${r.message_id}:${r.sign_hash}`,
	dialog_message_reactions: (r) => r.reaction_hash as string,
	dialog_message_receipts: (r) => r.receipt_hash as string,
};

const withDb = (fn: (tx: IDBTransaction) => void) => new Promise<void>((resolve, reject) => {
	const req = indexedDB.open('dialog-synced-cache', 2);
	req.onupgradeneeded = () => {
		for (const t of TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t, { keyPath: '__key' });
	};
	req.onerror = () => reject(req.error);
	req.onsuccess = () => {
		const db = req.result;
		const tx = db.transaction(TABLES, 'readwrite');
		fn(tx);
		tx.oncomplete = () => { db.close(); resolve(); };
		tx.onerror = () => reject(tx.error);
	};
});

export const setDialogCacheRow = (table: DialogCacheTable, _key: string, row: Row) => withDb((tx) => {
	tx.objectStore(table).put({ ...row, __awaitingEcho: false, __ignoreEchoSignHash: undefined, __key: mainKey[table](row) });
});

export const clearDialogCacheDb = () => withDb((tx) => { for (const t of TABLES) tx.objectStore(t).clear(); });

export const memoryDialogCacheStore = () => {
	const tables = new Map<string, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
	return {
		async getAll(t: string) { return [...tables.get(t)!.values()].map((r) => structuredClone(r)); },
		async get(t: string, k: string) { const r = tables.get(t)!.get(k); return r ? structuredClone(r) : undefined; },
		async put(t: string, r: Row) { tables.get(t)!.set(r.__key as string, structuredClone(r)); },
		async delete(t: string, k: string) { tables.get(t)!.delete(k); },
		async clear(t: string) { tables.get(t)!.clear(); },
		async seed(t: string, row: Row) { tables.get(t)!.set(mainKey[t as DialogCacheTable](row), { ...structuredClone(row), __awaitingEcho: false, __ignoreEchoSignHash: undefined, __key: mainKey[t as DialogCacheTable](row) }); },
	};
};
