import type { ResolvedPendingRecord, UserRecordFields } from '@/utils/db/tanstack/userQueue';
import type { ApiMutation } from '@/api/client';
import { MutationType } from '@/api/client';

export function assertReady(resolved: ResolvedPendingRecord): { ready: true; record: UserRecordFields; mutationType: MutationType } {
	if (!resolved.ready) throw new Error('expected resolvePendingRecord(...) to be ready');
	return resolved;
}

export function modifiedOf(mutation: ApiMutation): Record<string, unknown> {
	if (!mutation.modified) throw new Error('expected mutation.modified to be set (insert)');
	return mutation.modified;
}

export function changesOf(mutation: ApiMutation): Record<string, unknown> {
	if (!mutation.changes) throw new Error('expected mutation.changes to be set (update)');
	return mutation.changes;
}

const DIALOG_DB_NAMES = ['dialog-pending-queue', 'dialog-synced-cache'];

export async function clearDialogDatabases(): Promise<void> {
	await Promise.all(DIALOG_DB_NAMES.map(clearDatabaseContents));
}

function clearDatabaseContents(dbName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const openReq = indexedDB.open(dbName);
		openReq.onsuccess = () => {
			const db = openReq.result;
			const storeNames = Array.from(db.objectStoreNames);
			if (storeNames.length === 0) {
				db.close();
				const delReq = indexedDB.deleteDatabase(dbName);
				delReq.onsuccess = () => resolve();
				delReq.onerror = () => reject(delReq.error);
				delReq.onblocked = () => resolve();
				return;
			}
			const tx = db.transaction(storeNames, 'readwrite');
			for (const name of storeNames) tx.objectStore(name).clear();
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				reject(tx.error);
			};
		};
		openReq.onerror = () => reject(openReq.error);
	});
}

export async function deleteFromIndexedDB(dbName: string, storeName: string, key: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const openReq = indexedDB.open(dbName);
		openReq.onsuccess = () => {
			const db = openReq.result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.close();
				resolve();
				return;
			}
			const tx = db.transaction(storeName, 'readwrite');
			tx.objectStore(storeName).delete(key);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				reject(tx.error);
			};
		};
		openReq.onerror = () => reject(openReq.error);
	});
}

export async function readAllFromIndexedDB(dbName: string, storeName: string): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const openReq = indexedDB.open(dbName);
		openReq.onsuccess = () => {
			const db = openReq.result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.close();
				resolve([]);
				return;
			}
			const getAllReq = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
			getAllReq.onsuccess = () => {
				db.close();
				resolve(getAllReq.result);
			};
			getAllReq.onerror = () => {
				db.close();
				reject(getAllReq.error);
			};
		};
		openReq.onerror = () => reject(openReq.error);
	});
}
