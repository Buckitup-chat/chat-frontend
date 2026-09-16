// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

// useBreakpoint and useMenu are plain reactive state and work under jsdom, so
// they run for real — stubbing them would only risk drifting from their API.
vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const message = (over = {}) => ({
	id: 'dmsg_' + '1'.repeat(128),
	text: 'hello',
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	...over,
});

const render = (messages) =>
	mount(ChatWindow, {
		props: { title: 'Peer', messages, reactions: {} },
		global: { stubs: { Avatar: true } },
	});

/** Right-click a bubble to open the context menu. */
const openMenu = async (wrapper, index = 0) => {
	await wrapper.findAll('.message-bubble')[index].trigger('contextmenu');
	return wrapper.find('.context-menu');
};

describe('edit failure is visible', () => {
	// A versioned edit the server refused leaves everyone else on the previous
	// revision. Showing the attempted text with no marker made a rejected edit
	// indistinguishable from an accepted one.
	it('marks a message whose edit was rejected', () => {
		const w = render([message({ isMine: true, text: 'attempted', _editStatus: 'error' })]);

		const marker = w.find('.sync-status.error');
		expect(marker.exists()).toBe(true);
		expect(marker.attributes('title')).toMatch(/previous version/i);
	});

	it('shows an edit in flight differently from a rejected one', () => {
		const w = render([message({ isMine: true, _editStatus: 'syncing' })]);

		expect(w.find('.sync-status.pending').exists()).toBe(true);
		expect(w.find('.sync-status.error').exists()).toBe(false);
	});

	it('shows no edit marker on an untouched message', () => {
		const w = render([message({ isMine: true, _syncStatus: 'synced' })]);

		expect(w.find('.sync-status.error').exists()).toBe(false);
	});
});

describe('read receipts are never sent implicitly', () => {
	// The strongest property this component has to hold: a receipt cannot be
	// withdrawn, so merely displaying a message must not produce one.
	it('emits nothing when a message is rendered', async () => {
		const w = render([message()]);
		await w.vm.$nextTick();

		expect(w.emitted('acknowledgeMessage')).toBeUndefined();
	});

	it('emits nothing when the context menu is merely opened', async () => {
		const w = render([message()]);

		await openMenu(w);

		expect(w.emitted('acknowledgeMessage')).toBeUndefined();
	});

	it('emits once the user picks Confirm read', async () => {
		const msg = message();
		const w = render([msg]);

		const menu = await openMenu(w);
		const action = menu.findAll('.context-menu-action')
			.find((b) => b.text().includes('Confirm read'));
		expect(action).toBeTruthy();
		await action.trigger('click');

		expect(w.emitted('acknowledgeMessage')).toEqual([[msg.id]]);
	});

	it('offers no confirmation for my own message', async () => {
		const w = render([message({ isMine: true })]);

		const menu = await openMenu(w);
		const action = menu.findAll('.context-menu-action')
			.find((b) => b.text().includes('Confirm read'));

		expect(action).toBeUndefined();
	});

	it('offers no confirmation once this revision is already acknowledged', async () => {
		const w = render([message({ _acknowledgedByMe: true })]);

		const menu = await openMenu(w);
		const action = menu.findAll('.context-menu-action')
			.find((b) => b.text().includes('Confirm read'));

		expect(action).toBeUndefined();
	});

	it('offers no confirmation for a message that has not synced yet', async () => {
		const w = render([message({ _optimistic: true })]);

		const menu = await openMenu(w);
		const action = menu.findAll('.context-menu-action')
			.find((b) => b.text().includes('Confirm read'));

		expect(action).toBeUndefined();
	});

	it('shows the acknowledgement indicator on my message once the peer confirms', () => {
		const w = render([message({ isMine: true, _acknowledgedByPeers: 1 })]);

		const marker = w.find('.sync-status.acknowledged');
		expect(marker.exists()).toBe(true);
		expect(marker.attributes('title')).toMatch(/confirmed reading/i);
	});
});
