import { describe, it, expect, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

type DialogModule = typeof import('@/utils/db/tanstack/dialog');
type MessagesChange = Parameters<DialogModule['handleDialogMessagesChanges']>[0][number];
type ReactionsChange = Parameters<DialogModule['handleDialogReactionsChanges']>[0][number];

function withVirtualProps<Row extends Record<string, unknown>>(value: Row, key: string) {
	return { ...value, $synced: true as const, $origin: 'local' as const, $key: key, $collectionId: 'test' };
}

async function freshDialog() {
	vi.resetModules();
	vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'DISABLE_SYNC' ? 'true' : null) });
	const dialog = await import('@/utils/db/tanstack/dialog');
	await dialog.ensureDialogReady();
	return dialog;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('handleDialogMessagesChanges/handleDialogKeysChanges/etc. — normal Electric change handling', () => {
	it('an insert/update change records the row into the synced cache', async () => {
		const dialog = await freshDialog();
		const change: MessagesChange = { type: 'insert', key: 'dmsg_1', value: withVirtualProps({ message_id: 'dmsg_1', dialog_hash: 'di_x', content_b64: 'c' }, 'dmsg_1') };
		dialog.handleDialogMessagesChanges([change]);
		expect(dialog.cachedDialogMessagesCollection.get('dmsg_1')).toMatchObject({ content_b64: 'c' });
	});

	it('a delete change forgets the row from the synced cache', async () => {
		const dialog = await freshDialog();
		const insert: MessagesChange = { type: 'insert', key: 'dmsg_del', value: withVirtualProps({ message_id: 'dmsg_del', dialog_hash: 'di_x', content_b64: 'c' }, 'dmsg_del') };
		dialog.handleDialogMessagesChanges([insert]);
		expect(dialog.cachedDialogMessagesCollection.get('dmsg_del')).toBeTruthy();

		const del: MessagesChange = { type: 'delete', key: 'dmsg_del', value: withVirtualProps({ message_id: 'dmsg_del' }, 'dmsg_del') };
		dialog.handleDialogMessagesChanges([del]);
		expect(dialog.cachedDialogMessagesCollection.get('dmsg_del')).toBeUndefined();
	});

	it('a stale echo (sign_hash exactly matches the recorded __ignoreEchoSignHash) does not overwrite the cached row', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		const staleSignHash = 'dms_' + 'a'.repeat(128);
		await recordSynced('dialog_messages', 'dmsg_stale', { message_id: 'dmsg_stale', content_b64: 'edited' }, true, staleSignHash);

		const change: MessagesChange = {
			type: 'insert',
			key: 'dmsg_stale',
			value: withVirtualProps({ message_id: 'dmsg_stale', dialog_hash: 'di_x', content_b64: 'pre-edit-original', sign_hash: staleSignHash }, 'dmsg_stale'),
		};
		dialog.handleDialogMessagesChanges([change]);

		expect(dialog.cachedDialogMessagesCollection.get('dmsg_stale')).toMatchObject({ content_b64: 'edited' });
	});

	it('a delta with a different sign_hash is applied normally, not suppressed', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', 'dmsg_real_change', { message_id: 'dmsg_real_change', content_b64: 'edited' }, true, 'dms_' + 'a'.repeat(128));

		const change: MessagesChange = {
			type: 'insert',
			key: 'dmsg_real_change',
			value: withVirtualProps(
				{ message_id: 'dmsg_real_change', dialog_hash: 'di_x', content_b64: 'someone-elses-newer-edit', sign_hash: 'dms_' + 'b'.repeat(128) },
				'dmsg_real_change'
			),
		};
		dialog.handleDialogMessagesChanges([change]);

		expect(dialog.cachedDialogMessagesCollection.get('dmsg_real_change')).toMatchObject({ content_b64: 'someone-elses-newer-edit' });
	});

	it('reactions/receipts/keys changes (no sign_hash field) are always applied normally — the stale-echo mechanism only ever matches on dialog_messages sign_hash', async () => {
		const dialog = await freshDialog();
		const change: ReactionsChange = {
			type: 'insert',
			key: 'dmr_1',
			value: withVirtualProps({ reaction_hash: 'dmr_1', dialog_hash: 'di_x', message_id: 'dmsg_1', type_b64: 't' }, 'dmr_1'),
		};
		dialog.handleDialogReactionsChanges([change]);
		expect(dialog.cachedDialogReactionsCollection.get('dmr_1')).toMatchObject({ type_b64: 't' });
	});
});

describe('getDialogKeys — pending/cache precedence and deleted_flag semantics', () => {
	it('pending takes precedence over cache/network', async () => {
		const dialog = await freshDialog();
		await dialog.upsertDialogKeys({
			dialog_hash: 'di_prec',
			sender_hash: 'u_a',
			peer_kem_wrap_key_b64: 'k',
			peer_wrapped_msg_key_b64: 'w',
			ownerUserHash: 'u_a',
		});
		const result = await dialog.getDialogKeys('di_prec', 'u_a');
		expect(result).toMatchObject({ dialog_hash: 'di_prec' });
	});

	it('deleted_flag === false -> record visible', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_keys', 'di_false:u_a', { dialog_hash: 'di_false', sender_hash: 'u_a', deleted_flag: false });
		expect(await dialog.getDialogKeys('di_false', 'u_a')).toMatchObject({ dialog_hash: 'di_false' });
	});

	it('deleted_flag === true -> null', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_keys', 'di_true:u_a', { dialog_hash: 'di_true', sender_hash: 'u_a', deleted_flag: true });
		expect(await dialog.getDialogKeys('di_true', 'u_a')).toBeNull();
	});

	it('deleted_flag null/undefined -> null (fail-closed)', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_keys', 'di_null:u_a', { dialog_hash: 'di_null', sender_hash: 'u_a' });
		expect(await dialog.getDialogKeys('di_null', 'u_a')).toBeNull();
	});

	it('unknown key -> null', async () => {
		const dialog = await freshDialog();
		expect(await dialog.getDialogKeys('di_never_existed', 'u_a')).toBeNull();
	});
});

describe('getDialogMessage/getDialogReaction/getDialogReceipt — pending/cache precedence', () => {
	it('getDialogMessage: pending overrides cache', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', 'dmsg_prec', { message_id: 'dmsg_prec', dialog_hash: 'di_x', sender_hash: 'u_a', content_b64: 'synced' });
		await dialog.upsertDialogMessage({
			message_id: 'dmsg_prec',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'in-flight-edit',
			deleted_flag: false,
			ownerUserHash: 'u_a',
		});
		expect(await dialog.getDialogMessage('dmsg_prec')).toMatchObject({ content_b64: 'in-flight-edit' });
	});

	it('getDialogMessage: falls back to cache when nothing pending', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', 'dmsg_cache_only', { message_id: 'dmsg_cache_only', content_b64: 'cached' });
		expect(await dialog.getDialogMessage('dmsg_cache_only')).toMatchObject({ content_b64: 'cached' });
	});

	it('getDialogMessage: unknown id -> null', async () => {
		const dialog = await freshDialog();
		expect(await dialog.getDialogMessage('dmsg_never_existed')).toBeNull();
	});

	it('getDialogReaction: cache fallback and unknown -> null', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_message_reactions', 'dmr_cache', { reaction_hash: 'dmr_cache', type_b64: 't' });
		expect(await dialog.getDialogReaction('dmr_cache')).toMatchObject({ type_b64: 't' });
		expect(await dialog.getDialogReaction('dmr_never_existed')).toBeNull();
	});

	it('getDialogReceipt: cache fallback and unknown -> null', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_message_receipts', 'dmrc_cache', { receipt_hash: 'dmrc_cache', type: 'read' });
		expect(await dialog.getDialogReceipt('dmrc_cache')).toMatchObject({ type: 'read' });
		expect(await dialog.getDialogReceipt('dmrc_never_existed')).toBeNull();
	});
});

describe('upsertDialogX — normal validation, no-op, and pending creation', () => {
	it('upsertDialogKeys throws without ownerUserHash', async () => {
		const dialog = await freshDialog();
		await expect(
			dialog.upsertDialogKeys({ dialog_hash: 'di_x', sender_hash: 'u_a', peer_kem_wrap_key_b64: 'k', peer_wrapped_msg_key_b64: 'w', ownerUserHash: '' })
		).rejects.toThrow();
	});

	it('upsertDialogMessage creates a pending entry visible via the pending collection', async () => {
		const dialog = await freshDialog();
		await dialog.upsertDialogMessage({
			message_id: 'dmsg_new',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'new-content',
			deleted_flag: false,
			ownerUserHash: 'u_a',
		});
		expect(dialog.pendingDialogMessagesCollection.get('dmsg_new')).toMatchObject({ content_b64: 'new-content' });
	});

	it('upsertDialogMessage is a no-op (no new pending entry) when no tracked column actually changed', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', 'dmsg_noop', {
			message_id: 'dmsg_noop',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'unchanged',
			deleted_flag: false,
		});

		await dialog.upsertDialogMessage({
			message_id: 'dmsg_noop',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'unchanged',
			deleted_flag: false,
			ownerUserHash: 'u_a',
		});

		expect(dialog.pendingDialogMessagesCollection.get('dmsg_noop')).toBeUndefined();
	});

	it('upsertDialogMessage with actually changed content creates a pending entry', async () => {
		const dialog = await freshDialog();
		const { recordSynced } = await import('@/utils/db/tanstack/dialogCache');
		await recordSynced('dialog_messages', 'dmsg_changed', {
			message_id: 'dmsg_changed',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'original',
			deleted_flag: false,
		});

		await dialog.upsertDialogMessage({
			message_id: 'dmsg_changed',
			dialog_hash: 'di_x',
			sender_hash: 'u_a',
			content_b64: 'edited',
			deleted_flag: false,
			ownerUserHash: 'u_a',
		});

		expect(dialog.pendingDialogMessagesCollection.get('dmsg_changed')).toMatchObject({ content_b64: 'edited' });
	});

	it('upsertDialogReaction/upsertDialogReceipt create pending entries under their own table', async () => {
		const dialog = await freshDialog();
		await dialog.upsertDialogReaction({
			reaction_hash: 'dmr_new',
			dialog_hash: 'di_x',
			message_id: 'dmsg_1',
			message_sign_hash: 'dms_' + 'a'.repeat(128),
			reactor_hash: 'u_a',
			type_b64: 't',
			deleted_flag: false,
			ownerUserHash: 'u_a',
		});
		expect(dialog.pendingDialogReactionsCollection.get('dmr_new')).toMatchObject({ type_b64: 't' });

		await dialog.upsertDialogReceipt({
			receipt_hash: 'dmrc_new',
			dialog_hash: 'di_x',
			message_id: 'dmsg_1',
			message_sign_hash: 'dms_' + 'a'.repeat(128),
			type: 'delivered',
			ownerUserHash: 'u_a',
		});
		expect(dialog.pendingDialogReceiptsCollection.get('dmrc_new')).toMatchObject({ type: 'delivered' });
	});
});
