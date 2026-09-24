import { getUserStorageCollection } from './collections';
import type { UserStorageRow } from './types';

/**
 * Server state for one slot. `absent` and `unavailable` are deliberately
 * distinct: only `absent` proves an insert is the right mutation.
 * A tombstone counts as `found` — the logical PK exists, so writes remain
 * updates.
 */
export type ServerLookup =
	| { state: 'found'; row: UserStorageRow }
	| { state: 'absent' }
	| { state: 'unavailable'; error: unknown };

export const tsOf = (row?: UserStorageRow | null): number => Number(row?.owner_timestamp || 0);

export const entityKeyFor = (userHash: string, uuid: string): string => `${userHash}|${uuid}`;

export async function getServerState(userHash: string, uuid: string): Promise<ServerLookup> {
	const coll = getUserStorageCollection(userHash);
	try {
		await coll.preload();
	} catch (error) {
		return { state: 'unavailable', error };
	}
	const row = coll.get(`${userHash}|${uuid}`) as UserStorageRow | undefined;
	if (!row) return { state: 'absent' };
	// Tombstones included on purpose: the row exists, so a write is an update
	return { state: 'found', row };
}
