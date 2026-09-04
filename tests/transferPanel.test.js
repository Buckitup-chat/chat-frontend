// @vitest-environment jsdom
// Screen 10 rendered: header aggregate, the five row states in the board's
// wording, the cut-off line, per-row actions and the quiet cancel.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ uploadAttachment: vi.fn(), sendMessage: vi.fn() }),
}));

const { useTransfersStore } = await import('@/store/transfers.store');
const TransferPanel = (await import('@/components/chat/TransferPanel.vue')).default;

const row = (over = {}) => ({
	id: over.id ?? `tr_${Math.random()}`,
	batchId: 'b1', name: 'report.pdf', size: 2_400_000, mimeType: 'application/pdf',
	createdAt: 0, blob: null, status: 'waiting', done: 0, total: 14, speed: 0,
	prepared: { fileId: 'f_x', encSecretB64: 'x' }, part: null, ...over,
});

describe('transfer panel', () => {
	let store;
	beforeEach(() => {
		setActivePinia(createPinia());
		store = useTransfersStore();
	});

	const render = () => mount(TransferPanel);

	it('renders nothing while the queue is empty', () => {
		expect(render().find('.transfer-panel').exists()).toBe(false);
	});

	it('shows the header aggregate over the rows', () => {
		store.items = [row({ status: 'active', done: 9 }), row(), row()];
		const w = render();
		expect(w.find('.transfer-title').text()).toBe('Transfers · 3 files');
		expect(w.find('.transfer-sub').text()).toContain('1 running · 2 waiting');
	});

	it('words the five states the way the board does', () => {
		store.items = [
			row({ id: 'a', status: 'active', done: 9, speed: 1.8 * 1048576 }),
			row({ id: 'b', status: 'paused', done: 3 }),
			row({ id: 'c', status: 'waiting' }),
			row({ id: 'd', status: 'error' }),
		];
		const caps = render().findAll('.transfer-caption').map((c) => c.text());
		expect(caps[0]).toMatch(/64% · chunk 9 of 14 · 1\.8 MB\/s/);
		expect(caps[1]).toMatch(/^Paused · 21%/);
		expect(caps[2]).toMatch(/^Waiting · 2\.3 MB/);
		expect(caps[3]).toMatch(/Interrupted/);
	});

	it('cuts the list off with an "N more" line instead of growing', () => {
		store.items = Array.from({ length: 6 }, (_, i) => row({ id: `r${i}` }));
		const w = render();
		expect(w.findAll('.transfer-row')).toHaveLength(4);
		expect(w.find('.transfer-more').text()).toBe('2 more files');
	});

	it('pauses the active row and resumes a paused one', async () => {
		const pause = vi.spyOn(store, 'pause');
		const start = vi.spyOn(store, 'start');
		store.items = [row({ id: 'a', status: 'active' }), row({ id: 'b', status: 'paused' })];
		const w = render();
		// 'Start all' lives in the header; row actions follow it
		const buttons = w.findAll('.transfer-row .transfer-btn');
		expect(buttons.map((b) => b.text())).toEqual(['Pause', 'Resume']);
		await buttons[0].trigger('click');
		expect(pause).toHaveBeenCalledWith('a');
		await buttons[1].trigger('click');
		expect(start).toHaveBeenCalledWith('b');
	});

	it('cancels ONE row through the quiet cross', async () => {
		const cancel = vi.spyOn(store, 'cancel');
		store.items = [row({ id: 'a', status: 'active' }), row({ id: 'b' })];
		await render().findAll('.transfer-cancel')[0].trigger('click');
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledWith('a');
	});

	it('reorders by drag between rows', async () => {
		const reorder = vi.spyOn(store, 'reorder');
		store.items = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
		const w = render();
		const rows = w.findAll('.transfer-row');
		await rows[2].trigger('dragstart');
		await rows[0].trigger('drop');
		expect(reorder).toHaveBeenCalledWith(2, 0);
	});

	it('collapses into the one-line counter and back', async () => {
		store.items = [row({ status: 'active', done: 7 })];
		const w = render();
		await w.find('.transfer-fold').trigger('click');
		expect(w.find('.transfer-collapsed').text()).toContain('transfers · 50%');
		await w.find('.transfer-collapsed').trigger('click');
		expect(w.find('.transfer-head').exists()).toBe(true);
	});
});
