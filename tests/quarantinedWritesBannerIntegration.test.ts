// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import {
	enqueue, recordFailure, discardEntry, drainOutbox, blockedDependentIssues, _setStorageForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const editMessage = (messageId: string) => ([{
	type: 'update',
	modified: {
		message_id: messageId, sender_hash: MY_HASH, dialog_hash: 'dh1',
		content_b64: 'x', parent_sign_hash: null, owner_timestamp: 1,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const userPQState = reactive({ currentUserHash: MY_HASH });
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => userPQState,
}));

const QuarantinedWritesBanner = (await import('@/components/QuarantinedWritesBanner.vue')).default;

beforeEach(() => {
	setActivePinia(createPinia());
	userPQState.currentUserHash = MY_HASH;
	_setStorageForTests(makeStorage());
});

describe('QuarantinedWritesBanner integration: real outbox.ts, real terminal markers (U7/L17-09)', () => {
	it('1. a quarantined A shows Retry and Discard', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		expect(w.find('.quarantine-banner-text').text()).toContain('A message');
		expect(w.findAll('.quarantine-banner-action')).toHaveLength(2);
	});

	it('2. B blocked by quarantined A is shown separately, with no Retry for B', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [aId as string] });

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		const rows = w.findAll('.quarantine-banner-row');
		expect(rows).toHaveLength(2); // A's quarantine row + B's blocked row
		const blockedRow = w.find('.quarantine-banner-row--blocked');
		expect(blockedRow.exists()).toBe(true);
		expect(blockedRow.text()).toContain('failed prerequisite');
		expect(blockedRow.findAll('.quarantine-banner-action')).toHaveLength(1); // Discard only
	});

	it('3. after Discard A: the quarantine row for A disappears, B\'s blocked row survives with an updated (discarded) reason', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bId = await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [aId as string] });

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		expect(w.text()).toContain('failed prerequisite');

		await w.find('.quarantine-banner-row:not(.quarantine-banner-row--blocked) .quarantine-banner-discard').trigger('click');
		await flushPromises();

		expect(w.findAll('.quarantine-banner-row:not(.quarantine-banner-row--blocked)')).toHaveLength(0); // A's quarantine row is gone
		const blockedRow = w.find('.quarantine-banner-row--blocked');
		expect(blockedRow.exists()).toBe(true); // B is still visible
		expect(blockedRow.text()).toContain('discarded prerequisite'); // reason updated

		const issues = await blockedDependentIssues(MY_HASH);
		expect(issues.find((i) => i.entry.id === bId)?.blockers[0]).toMatchObject({ id: aId, status: 'discarded' });
	});

	it('4. explicit Discard B removes B from the list', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await discardEntry(aId as string);
		await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [aId as string] });

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		expect(w.find('.quarantine-banner-row--blocked').exists()).toBe(true);

		await w.find('.quarantine-banner-row--blocked .quarantine-banner-discard').trigger('click');
		await flushPromises();

		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('5. chain A -> B -> C: discard A shows B; discard B shows C instead, and no transport ever runs for B or C', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bId = await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [aId as string] });
		await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [bId as string] }); // C

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		let blockedRows = w.findAll('.quarantine-banner-row--blocked');
		expect(blockedRows).toHaveLength(1); // B, blocked by quarantined A
		expect(blockedRows[0].text()).toContain('failed prerequisite');

		await w.find('.quarantine-banner-row:not(.quarantine-banner-row--blocked) .quarantine-banner-discard').trigger('click');
		await flushPromises();

		blockedRows = w.findAll('.quarantine-banner-row--blocked');
		expect(blockedRows).toHaveLength(1); // B, now blocked by discarded A
		expect(blockedRows[0].text()).toContain('discarded prerequisite');

		await blockedRows[0].find('.quarantine-banner-discard').trigger('click');
		await flushPromises();

		blockedRows = w.findAll('.quarantine-banner-row--blocked');
		expect(blockedRows).toHaveLength(1); // B is gone; C now shown, blocked by discarded B
		expect(blockedRows[0].text()).toContain('discarded prerequisite');

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
	});

	it('6. a pending-only dependency does not create a failure banner', async () => {
		const aId = await enqueue(editMessage('msg_A'), MY_HASH);
		await enqueue(editMessage('msg_A'), MY_HASH, { dependsOn: [aId as string] }); // B waits on pending A — no failure

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});
});
