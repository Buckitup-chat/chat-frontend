// @vitest-environment jsdom
// Screen 11: one line over the shell, expandable in place, marked dialogs.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ uploadAttachment: vi.fn(), sendMessage: vi.fn() }),
}));

const { useTransfersStore } = await import('@/store/transfers.store');
const TransferDock = (await import('@/components/chat/TransferDock.vue')).default;

const seed = (store) => {
	store.items = [
		{ id: 'a', batchId: 'b1', name: 'x', size: 1, mimeType: '', createdAt: 0, blob: null,
			status: 'active', done: 1, total: 4, speed: 0, prepared: {}, part: null },
	];
	store.$patch(() => {}); // ensure reactivity settled
	// transferPeers derives from batches
	store.enqueueBatch; // noop touch
};

describe('transfer dock', () => {
	beforeEach(() => setActivePinia(createPinia()));

	it('renders nothing with an empty queue', () => {
		expect(mount(TransferDock).find('.transfer-dock').exists()).toBe(false);
	});

	it('folds into one line and expands on the same tap', async () => {
		const store = useTransfersStore();
		seed(store);
		const w = mount(TransferDock);
		const line = w.find('.transfer-dock-line');
		expect(line.text()).toContain('keep this tab open');
		expect(line.text()).toContain('25%');
		await line.trigger('click');
		expect(w.find('.transfer-head').exists()).toBe(true); // full panel in place
		await w.find('.transfer-dock-fold').trigger('click');
		expect(w.find('.transfer-dock-line').exists()).toBe(true);
	});
});
