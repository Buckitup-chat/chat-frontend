import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

async function freshMigration() {
	vi.resetModules();
	const dialogQueue = await import('@/utils/db/tanstack/dialogQueue');
	await dialogQueue.ensureRehydrated();
	const dialogCache = await import('@/utils/db/tanstack/dialogCache');
	await dialogCache.ensureDialogCacheHydrated();
	const migration = await import('@/utils/db/tanstack/dialogLegacyMigration');
	return { dialogQueue, dialogCache, migration };
}

let counter = 0;
function uniqueNames() {
	const n = ++counter;
	return { legacyIdbName: `legacy-unit-${n}`, statusDbName: `status-unit-${n}` };
}

describe('migrateLegacyDialogState — no legacy database present', () => {
	it('completes, writes the marker, imports nothing', async () => {
		const { legacyIdbName, statusDbName } = uniqueNames();
		const { migration } = await freshMigration();

		const result = await migration.migrateLegacyDialogState({ legacyIdbName, statusDbName });

		expect(result.ran).toBe(true);
		expect(result.importedPending).toBe(0);
		expect(result.importedCached).toBe(0);
	});

	it('the marker prevents a second run from doing anything further', async () => {
		const { legacyIdbName, statusDbName } = uniqueNames();
		const first = await freshMigration();
		await first.migration.migrateLegacyDialogState({ legacyIdbName, statusDbName });

		const second = await freshMigration();
		const result = await second.migration.migrateLegacyDialogState({ legacyIdbName, statusDbName });
		expect(result.ran).toBe(false);
	});

	it('concurrent calls in the same session share one in-flight run', async () => {
		const { legacyIdbName, statusDbName } = uniqueNames();
		const { migration } = await freshMigration();
		const [a, b] = await Promise.all([
			migration.migrateLegacyDialogState({ legacyIdbName, statusDbName }),
			migration.migrateLegacyDialogState({ legacyIdbName, statusDbName }),
		]);
		expect(a).toBe(b);
	});
});

describe('importLegacyRows — routes each legacy row to the correct destination', () => {
	it('a legacy row old considered unsent (modified_columns set) imports into the durable pending queue, with ownerUserHash derived from the row', async () => {
		const { dialogQueue, migration } = await freshMigration();
		const spec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_messages')!;

		const result = await migration.importLegacyRows(spec, [
			{ message_id: 'dmsg_legacy_pending', dialog_hash: 'di_x', sender_hash: 'u_a', content_b64: 'c', deleted_flag: false, modified_columns: ['__all__'] },
		]);

		expect(result.importedPending).toBe(1);
		expect(result.importedCached).toBe(0);
		const entry = dialogQueue.pendingDialogMessagesCollection.get('dmsg_legacy_pending');
		expect(entry).toMatchObject({ message_id: 'dmsg_legacy_pending', content_b64: 'c' });
	});

	it('a legacy row old considered already-synced (modified_columns NULL) imports into the synced cache, not the pending queue, with protocol fields intact', async () => {
		const { dialogQueue, dialogCache, migration } = await freshMigration();
		const spec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_messages')!;

		const result = await migration.importLegacyRows(spec, [
			{ message_id: 'dmsg_legacy_synced', dialog_hash: 'di_x', sender_hash: 'u_a', content_b64: 'confirmed-content', deleted_flag: false, owner_timestamp: 500, modified_columns: null },
		]);

		expect(result.importedCached).toBe(1);
		expect(result.importedPending).toBe(0);
		expect(dialogQueue.pendingDialogMessagesCollection.get('dmsg_legacy_synced')).toBeUndefined();
		expect(dialogCache.cachedDialogMessagesCollection.get('dmsg_legacy_synced')).toMatchObject({ content_b64: 'confirmed-content', owner_timestamp: 500 });
	});

	it('an existing destination entry is reported already-present and is not duplicated or overwritten', async () => {
		const { dialogQueue, migration } = await freshMigration();
		const spec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_messages')!;

		await dialogQueue.importLegacyPendingEntry(
			'dialog_messages',
			'dmsg_already_there',
			{ message_id: 'dmsg_already_there', content_b64: 'live-edit-since-upgrade' },
			'u_a'
		);

		const result = await migration.importLegacyRows(spec, [
			{ message_id: 'dmsg_already_there', dialog_hash: 'di_x', sender_hash: 'u_a', content_b64: 'stale-legacy-content', deleted_flag: false, modified_columns: ['__all__'] },
		]);

		expect(result.alreadyPresent).toBe(1);
		expect(result.importedPending).toBe(0);
		expect(dialogQueue.pendingDialogMessagesCollection.get('dmsg_already_there')).toMatchObject({ content_b64: 'live-edit-since-upgrade' });
	});

	it('a row missing its own primary key is skipped and counted, not imported anywhere, matching the documented "skip malformed" behavior', async () => {
		const { migration } = await freshMigration();
		const spec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_keys')!;

		const result = await migration.importLegacyRows(spec, [
			{ dialog_hash: 'di_malformed', sender_hash: null, peer_kem_wrap_key_b64: 'k' },
			{ dialog_hash: 'di_valid', sender_hash: 'u_a', peer_kem_wrap_key_b64: 'k', modified_columns: ['__all__'] },
		]);

		expect(result.skippedMalformed).toBe(1);
		expect(result.importedPending).toBe(1);
	});

	it('each of the five legacy tables routes to its own destination collection, keyed as documented', async () => {
		const { dialogQueue, migration } = await freshMigration();

		const keysSpec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_keys')!;
		await migration.importLegacyRows(keysSpec, [{ dialog_hash: 'di_y', sender_hash: 'u_a', peer_kem_wrap_key_b64: 'k', peer_wrapped_msg_key_b64: 'w', modified_columns: ['__all__'] }]);
		expect(dialogQueue.pendingDialogKeysCollection.get('di_y:u_a')).toBeTruthy();

		const versionsSpec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_messages_versions')!;
		await migration.importLegacyRows(versionsSpec, [{ message_id: 'dmsg_v', sign_hash: 'dms_' + 'a'.repeat(128), content_b64: 'c', modified_columns: ['__all__'] }]);
		expect(dialogQueue.pendingDialogMessageVersionsCollection.get(`dmsg_v:dms_${'a'.repeat(128)}`)).toBeTruthy();

		const reactionsSpec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_message_reactions')!;
		await migration.importLegacyRows(reactionsSpec, [{ reaction_hash: 'dmr_y', message_id: 'dmsg_1', message_sign_hash: 'dms_x', modified_columns: ['__all__'] }]);
		expect(dialogQueue.pendingDialogReactionsCollection.get('dmr_y')).toBeTruthy();

		const receiptsSpec = migration.LEGACY_TABLES.find((t) => t.table === 'dialog_message_receipts')!;
		await migration.importLegacyRows(receiptsSpec, [{ receipt_hash: 'dmrc_y', message_id: 'dmsg_1', modified_columns: ['__all__'] }]);
		expect(dialogQueue.pendingDialogReceiptsCollection.get('dmrc_y')).toBeTruthy();
	});
});
