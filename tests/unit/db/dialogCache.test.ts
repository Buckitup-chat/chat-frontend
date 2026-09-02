import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { DialogRecordFields } from '@/utils/db/tanstack/dialogQueue';

type CachedRecord = DialogRecordFields & { __awaitingEcho?: boolean; __ignoreEchoSignHash?: string };

async function freshCache() {
	vi.resetModules();
	const c = await import('@/utils/db/tanstack/dialogCache');
	await c.ensureDialogCacheHydrated();
	return c;
}

describe('recordSynced — writes to the matching TanStack collection and IndexedDB store', () => {
	it('dialog_keys', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_keys', 'di_x:u_a', { dialog_hash: 'di_x', sender_hash: 'u_a', peer_kem_wrap_key_b64: 'k' });
		expect(c.cachedDialogKeysCollection.get('di_x:u_a')).toMatchObject({ dialog_hash: 'di_x' });
	});

	it('dialog_messages', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_x', { message_id: 'dmsg_x', content_b64: 'c' });
		expect(c.cachedDialogMessagesCollection.get('dmsg_x')).toMatchObject({ message_id: 'dmsg_x', content_b64: 'c' });
	});

	it('dialog_messages_versions', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages_versions', 'dmsg_x:dms_y', { message_id: 'dmsg_x', sign_hash: 'dms_y', content_b64: 'c' });
		expect(c.cachedDialogMessageVersionsCollection.get('dmsg_x:dms_y')).toMatchObject({ message_id: 'dmsg_x', sign_hash: 'dms_y' });
	});

	it('dialog_message_reactions', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_message_reactions', 'dmr_x', { reaction_hash: 'dmr_x', message_id: 'dmsg_x', type_b64: 't' });
		expect(c.cachedDialogReactionsCollection.get('dmr_x')).toMatchObject({ reaction_hash: 'dmr_x' });
	});

	it('dialog_message_receipts', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_message_receipts', 'dmrc_x', { receipt_hash: 'dmrc_x', message_id: 'dmsg_x', type: 'read' });
		expect(c.cachedDialogReceiptsCollection.get('dmrc_x')).toMatchObject({ receipt_hash: 'dmrc_x' });
	});

	it('__awaitingEcho is recorded as given: true for a fresh confirm, false (default) otherwise', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_awaiting', { message_id: 'dmsg_awaiting', content_b64: 'c' }, true);
		expect((c.cachedDialogMessagesCollection.get('dmsg_awaiting') as CachedRecord | undefined)?.__awaitingEcho).toBe(true);

		await c.recordSynced('dialog_messages', 'dmsg_not_awaiting', { message_id: 'dmsg_not_awaiting', content_b64: 'c' });
		expect((c.cachedDialogMessagesCollection.get('dmsg_not_awaiting') as CachedRecord | undefined)?.__awaitingEcho).toBe(false);
	});

	it("a record for one table never appears in another table's collection", async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'shared_key_1', { message_id: 'shared_key_1', content_b64: 'c' });
		await c.recordSynced('dialog_message_reactions', 'shared_key_1', { reaction_hash: 'shared_key_1', message_id: 'dmsg_x' });

		expect(c.cachedDialogMessagesCollection.get('shared_key_1')).toMatchObject({ content_b64: 'c' });
		expect(c.cachedDialogReactionsCollection.get('shared_key_1')).toMatchObject({ message_id: 'dmsg_x' });
		expect((c.cachedDialogMessagesCollection.get('shared_key_1') as Record<string, unknown> | undefined)?.reaction_hash).toBeUndefined();
		expect((c.cachedDialogReactionsCollection.get('shared_key_1') as Record<string, unknown> | undefined)?.content_b64).toBeUndefined();
	});

	it('persists durably: survives a simulated reload (fresh module import)', async () => {
		const c1 = await freshCache();
		await c1.recordSynced('dialog_messages', 'dmsg_durable', { message_id: 'dmsg_durable', content_b64: 'durable-content' });

		const c2 = await freshCache();
		expect(c2.cachedDialogMessagesCollection.get('dmsg_durable')).toMatchObject({ content_b64: 'durable-content' });
	});
});

describe('stripCacheMetadata', () => {
	it('removes __awaitingEcho and __ignoreEchoSignHash, keeps protocol fields untouched', async () => {
		const c = await freshCache();
		const raw: CachedRecord = { message_id: 'dmsg_x', content_b64: 'c', deleted_flag: false, __awaitingEcho: true, __ignoreEchoSignHash: 'dms_y' };
		const stripped = c.stripCacheMetadata(raw)!;
		expect('__awaitingEcho' in stripped).toBe(false);
		expect('__ignoreEchoSignHash' in stripped).toBe(false);
		expect(stripped.message_id).toBe('dmsg_x');
		expect(stripped.content_b64).toBe('c');
		expect(stripped.deleted_flag).toBe(false);
	});

	it('is a no-op (returns the same shape) when neither metadata field is present', async () => {
		const c = await freshCache();
		const clean = { message_id: 'dmsg_x', content_b64: 'c' };
		expect(c.stripCacheMetadata(clean)).toEqual(clean);
	});

	it('passes through null/undefined unchanged', async () => {
		const c = await freshCache();
		expect(c.stripCacheMetadata(null)).toBeNull();
		expect(c.stripCacheMetadata(undefined)).toBeUndefined();
	});
});

describe('forgetSynced', () => {
	it('removes the record from the TanStack collection and from IndexedDB, without touching other records', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_keep', { message_id: 'dmsg_keep', content_b64: 'keep' });
		await c.recordSynced('dialog_messages', 'dmsg_forget', { message_id: 'dmsg_forget', content_b64: 'forget' });

		c.forgetSynced('dialog_messages', 'dmsg_forget');
		await new Promise((r) => setTimeout(r, 0));

		expect(c.cachedDialogMessagesCollection.get('dmsg_forget')).toBeUndefined();
		expect(c.cachedDialogMessagesCollection.get('dmsg_keep')).toMatchObject({ content_b64: 'keep' });

		const c2 = await freshCache();
		expect(c2.cachedDialogMessagesCollection.get('dmsg_forget')).toBeUndefined();
		expect(c2.cachedDialogMessagesCollection.get('dmsg_keep')).toMatchObject({ content_b64: 'keep' });
	});
});

describe('cache rehydration', () => {
	it('persisted records reappear in their TanStack collections after reload, and isDialogCacheHydrated becomes true', async () => {
		const c1 = await freshCache();
		await c1.recordSynced('dialog_keys', 'di_hydrate:u_a', { dialog_hash: 'di_hydrate', sender_hash: 'u_a' });

		vi.resetModules();
		const c2 = await import('@/utils/db/tanstack/dialogCache');
		expect(c2.isDialogCacheHydrated.value).toBe(false);
		await c2.ensureDialogCacheHydrated();
		expect(c2.isDialogCacheHydrated.value).toBe(true);
		expect(c2.cachedDialogKeysCollection.get('di_hydrate:u_a')).toMatchObject({ dialog_hash: 'di_hydrate' });
	});

	it('metadata (__awaitingEcho) is preserved across rehydration where it was set', async () => {
		const c1 = await freshCache();
		await c1.recordSynced('dialog_messages', 'dmsg_meta_survives', { message_id: 'dmsg_meta_survives', content_b64: 'c' }, true);

		const c2 = await freshCache();
		expect((c2.cachedDialogMessagesCollection.get('dmsg_meta_survives') as CachedRecord | undefined)?.__awaitingEcho).toBe(true);
	});

	it('touchedKeys: a key already written by this runtime before hydration finishes is not overwritten by the older persisted value', async () => {
		const c1 = await freshCache();
		await c1.recordSynced('dialog_messages', 'dmsg_race', { message_id: 'dmsg_race', content_b64: 'old-persisted' });

		vi.resetModules();
		const c2 = await import('@/utils/db/tanstack/dialogCache');
		const hydratePromise = c2.ensureDialogCacheHydrated();
		await c2.recordSynced('dialog_messages', 'dmsg_race', { message_id: 'dmsg_race', content_b64: 'new-live-write' });
		await hydratePromise;

		expect(c2.cachedDialogMessagesCollection.get('dmsg_race')).toMatchObject({ content_b64: 'new-live-write' });
	});
});

describe('isStaleEchoOfRejectedEdit — exact stale-echo mechanism only', () => {
	it('true when the incoming sign_hash exactly matches the recorded __ignoreEchoSignHash', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_stale', { message_id: 'dmsg_stale', content_b64: 'edited' }, true, 'dms_' + 'a'.repeat(128));
		expect(c.isStaleEchoOfRejectedEdit('dialog_messages', 'dmsg_stale', 'dms_' + 'a'.repeat(128))).toBe(true);
	});

	it('false when the incoming sign_hash differs — a real subsequent change is not suppressed', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_stale2', { message_id: 'dmsg_stale2', content_b64: 'edited' }, true, 'dms_' + 'a'.repeat(128));
		expect(c.isStaleEchoOfRejectedEdit('dialog_messages', 'dmsg_stale2', 'dms_' + 'b'.repeat(128))).toBe(false);
	});

	it('false when incoming sign_hash is null or undefined', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_stale3', { message_id: 'dmsg_stale3', content_b64: 'edited' }, true, 'dms_' + 'a'.repeat(128));
		expect(c.isStaleEchoOfRejectedEdit('dialog_messages', 'dmsg_stale3', null)).toBe(false);
		expect(c.isStaleEchoOfRejectedEdit('dialog_messages', 'dmsg_stale3', undefined)).toBe(false);
	});

	it('false when no __ignoreEchoSignHash was ever recorded for the key (normal synced row)', async () => {
		const c = await freshCache();
		await c.recordSynced('dialog_messages', 'dmsg_normal', { message_id: 'dmsg_normal', content_b64: 'c' });
		expect(c.isStaleEchoOfRejectedEdit('dialog_messages', 'dmsg_normal', 'dms_' + 'a'.repeat(128))).toBe(false);
	});
});

describe('cache metadata does not leak into the protocol record', () => {
	it('a cache row carrying __awaitingEcho/__ignoreEchoSignHash, once passed through stripCacheMetadata and toProtocolRecord, contains neither', async () => {
		const c = await freshCache();
		const { toProtocolRecord } = await import('@/utils/db/tanstack/dialogQueue');
		await c.recordSynced('dialog_messages', 'dmsg_protocol', { message_id: 'dmsg_protocol', content_b64: 'c' }, true, 'dms_' + 'a'.repeat(128));

		const cached = c.cachedDialogMessagesCollection.get('dmsg_protocol')!;
		const stripped = c.stripCacheMetadata(cached)!;
		const protocolRecord = toProtocolRecord('dialog_messages', stripped);

		expect('__awaitingEcho' in protocolRecord).toBe(false);
		expect('__ignoreEchoSignHash' in protocolRecord).toBe(false);
		expect(protocolRecord.content_b64).toBe('c');
	});
});
