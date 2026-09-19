// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

let entries = [];
let blockedIssues = [];
const requeueEntry = vi.fn(async (id) => {
	entries = entries.filter((e) => e.id !== id);
});
const discardEntry = vi.fn(async (id) => {
	entries = entries.filter((e) => e.id !== id);
	blockedIssues = blockedIssues.filter((i) => i.entry.id !== id);
});
const quarantinedEntries = vi.fn(async () => entries);
const blockedDependentIssues = vi.fn(async () => blockedIssues);
vi.mock('@/lib/data/outbox', () => ({
	quarantinedEntries: (...args) => quarantinedEntries(...args),
	requeueEntry: (...args) => requeueEntry(...args),
	discardEntry: (...args) => discardEntry(...args),
	blockedDependentIssues: (...args) => blockedDependentIssues(...args),
}));

const userPQState = reactive({ currentUserHash: MY_HASH });
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => userPQState,
}));

const QuarantinedWritesBanner = (await import('@/components/QuarantinedWritesBanner.vue')).default;

beforeEach(() => {
	setActivePinia(createPinia());
	entries = [];
	blockedIssues = [];
	userPQState.currentUserHash = MY_HASH;
	requeueEntry.mockClear();
	discardEntry.mockClear();
	quarantinedEntries.mockReset().mockImplementation(async () => entries);
	blockedDependentIssues.mockReset().mockImplementation(async () => blockedIssues);
});

describe('QuarantinedWritesBanner (§F-L10)', () => {
	it('renders nothing when there is nothing quarantined or blocked', async () => {
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('surfaces a quarantined entry with its relation and last error, with Retry and Discard', async () => {
		entries = [{ id: 'e1', relation: 'dialog_messages', lastError: 'cannot react to own message' }];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		const text = w.find('.quarantine-banner-text').text();
		expect(text).toContain('A message');
		expect(text).toContain('cannot react to own message');
		expect(w.findAll('.quarantine-banner-action')).toHaveLength(2); // Retry + Discard
	});

	it('retry requeues the entry and drops it from the list', async () => {
		entries = [{ id: 'e1', relation: 'dialog_messages', lastError: 'boom' }];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		await w.find('.quarantine-banner-action').trigger('click');
		await flushPromises();
		expect(requeueEntry).toHaveBeenCalledWith('e1');
		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('discard removes the entry without requeuing it', async () => {
		entries = [{ id: 'e1', relation: 'user_storage', lastError: 'boom' }];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		await w.find('.quarantine-banner-discard').trigger('click');
		await flushPromises();
		expect(discardEntry).toHaveBeenCalledWith('e1');
		expect(requeueEntry).not.toHaveBeenCalled();
		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('a dependent blocked by a quarantined prerequisite is shown separately, without a Retry button', async () => {
		blockedIssues = [{
			entry: { id: 'b1', relation: 'dialog_messages' },
			blockers: [{ id: 'a1', relation: 'dialog_messages', status: 'quarantined', lastError: 'rejected' }],
		}];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		const row = w.find('.quarantine-banner-row--blocked');
		expect(row.exists()).toBe(true);
		expect(row.text()).toContain('A message');
		expect(row.text()).toContain('failed prerequisite');
		expect(row.text()).toContain('rejected');
		expect(row.findAll('.quarantine-banner-action')).toHaveLength(1); // Discard only
		expect(row.find('.quarantine-banner-discard').exists()).toBe(true);
	});

	it('discarding a blocked dependent calls discardEntry with the dependent\'s own id, not a blocker\'s', async () => {
		blockedIssues = [{
			entry: { id: 'b1', relation: 'dialog_messages' },
			blockers: [{ id: 'a1', relation: 'dialog_messages', status: 'discarded', lastError: 'rejected' }],
		}];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		await w.find('.quarantine-banner-row--blocked .quarantine-banner-discard').trigger('click');
		await flushPromises();

		expect(discardEntry).toHaveBeenCalledWith('b1');
		expect(discardEntry).not.toHaveBeenCalledWith('a1');
		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('a pending-only dependency (nothing quarantined/discarded) does not create a failure banner', async () => {
		entries = [];
		blockedIssues = []; // blockedDependentIssues already excludes pending-only blocks
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('a delayed scan for account A does not render after switching to account B', async () => {
		let releaseA;
		quarantinedEntries.mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve; }));
		blockedDependentIssues.mockImplementation(async () => []);

		const w = mount(QuarantinedWritesBanner); // triggers the immediate watch -> refresh() for A, now pending
		await flushPromises();

		userPQState.currentUserHash = OTHER_HASH; // switch before A's scan resolves
		entries = [{ id: 'b1', relation: 'dialog_messages', lastError: 'B err' }];
		await flushPromises(); // B's own refresh() runs and resolves immediately (default mock)

		expect(w.text()).toContain('B err');

		releaseA([{ id: 'a1', relation: 'dialog_messages', lastError: 'A err' }]); // A's stale scan finally lands
		await flushPromises();

		expect(w.text()).toContain('B err'); // unchanged
		expect(w.text()).not.toContain('A err'); // A's late result never applied
	});

	it('an older concurrent refresh does not overwrite a newer one\'s result', async () => {
		let releaseFirst;
		quarantinedEntries
			.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
			.mockImplementationOnce(async () => [{ id: 'second', relation: 'dialog_messages', lastError: 'second result' }]);
		blockedDependentIssues.mockImplementation(async () => []);

		const w = mount(QuarantinedWritesBanner); // first refresh() call, held
		await flushPromises();

		await w.vm.refresh(); // second, newer refresh() call — resolves immediately
		expect(w.text()).toContain('second result');

		releaseFirst([{ id: 'first', relation: 'dialog_messages', lastError: 'first result' }]); // stale
		await flushPromises();

		expect(w.text()).toContain('second result'); // still the newer one
		expect(w.text()).not.toContain('first result');
	});

	it('a late scan result after unmount does not throw or apply', async () => {
		let releaseLate;
		quarantinedEntries.mockImplementationOnce(() => new Promise((resolve) => { releaseLate = resolve; }));
		blockedDependentIssues.mockImplementation(async () => []);

		const w = mount(QuarantinedWritesBanner);
		await flushPromises();

		w.unmount();

		expect(() => releaseLate([{ id: 'late', relation: 'dialog_messages', lastError: 'late err' }])).not.toThrow();
		await flushPromises();
	});

	it('logout clears both quarantined and blocked rows', async () => {
		entries = [{ id: 'a1', relation: 'dialog_messages', lastError: 'x' }];
		const w = mount(QuarantinedWritesBanner);
		await flushPromises();
		expect(w.find('.quarantine-banner').exists()).toBe(true);

		userPQState.currentUserHash = null; // logout
		await flushPromises();

		expect(w.find('.quarantine-banner').exists()).toBe(false);
	});

	it('repeated polling does not duplicate rows', async () => {
		vi.useFakeTimers();
		try {
			entries = [{ id: 'a1', relation: 'dialog_messages', lastError: 'x' }];
			const w = mount(QuarantinedWritesBanner);
			await flushPromises();
			expect(w.findAll('.quarantine-banner-row')).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(w.findAll('.quarantine-banner-row')).toHaveLength(1);
			expect(quarantinedEntries.mock.calls.length).toBeGreaterThanOrEqual(3); // mount + 2 polls
		} finally {
			vi.useRealTimers();
		}
	});
});
