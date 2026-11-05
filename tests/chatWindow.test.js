// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
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

const render = (messages, opts = {}) =>
	mount(ChatWindow, {
		props: { title: 'Peer', messages, reactions: {} },
		global: { stubs: { Avatar: true } },
		...opts,
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

describe('editing a long message', () => {
	// Mounted with attachTo: a failed assertion must not leave a focused box and document listeners behind.
	enableAutoUnmount(afterEach);

	const text = 'line\n'.repeat(400);
	const mine = (id) => message({ id, isMine: true, text: `${id}: ${text}`, _syncStatus: 'synced' });
	const edit = async (w, index = 0) => {
		const menu = await openMenu(w, index);
		await menu.findAll('.context-menu-action').find((b) => b.text() === 'Edit').trigger('click');
		await flushPromises();
		return w.find('.message-edit textarea');
	};
	const editLong = async () => {
		const w = render([mine('m1')], { attachTo: document.body });
		return { w, box: await edit(w) };
	};

	// The edit box sat in a v-for, so its template ref was an array: focus()
	// threw and the box opened without a caret.
	it('opens focused, with the caret after the text', async () => {
		const { box } = await editLong();
		expect(document.activeElement).toBe(box.element);
		expect(box.element.selectionStart).toBe(box.element.value.length);
		expect(box.element.value).toBe(`m1: ${text}`);
	});

	// Vue mounts the new box before it unmounts the old one.
	it('focuses the box of an earlier message when the edit moves to it', async () => {
		const w = render([mine('m1'), mine('m2')], { attachTo: document.body });
		await edit(w, 1);
		const box = await edit(w, 0);
		expect(w.findAll('.message-edit textarea')).toHaveLength(1);
		expect(box.element.value).toBe(`m1: ${text}`);
		expect(document.activeElement).toBe(box.element);
	});

	it('keeps the bubble wide, and grows the box with its text as it is typed', async () => {
		const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
		try {
			const { w, box } = await editLong();
			expect(w.find('.message-bubble').classes()).toContain('message-editing');
			// the CSS caps it at half the screen and scrolls beyond that
			expect(box.element.style.height).toBe('900px');
			scrollHeight.mockReturnValue(950);
			await box.setValue(`${box.element.value}more`);
			expect(box.element.style.height).toBe('950px');
		} finally {
			scrollHeight.mockRestore();
		}
	});

	// Right-click and a long press are how text is selected, pasted and spell-checked.
	it('leaves the browser its own menu in the box, and a long press there opens none of ours', async () => {
		const { w, box } = await editLong();
		const right = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		box.element.dispatchEvent(right);
		await flushPromises();
		expect(right.defaultPrevented).toBe(false);
		expect(w.find('.context-menu').exists()).toBe(false);

		vi.useFakeTimers();
		try {
			await box.trigger('touchstart', { touches: [{ clientX: 50, clientY: 60 }] });
			await vi.advanceTimersByTimeAsync(600);
			expect(w.find('.context-menu').exists()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
		expect(box.element.value).toBe(`m1: ${text}`);
	});

	it('is not carried out of view by a message arriving meanwhile', async () => {
		const { w } = await editLong();
		const chat = w.find('.chat-body').element;
		chat.scrollTop = 120;
		await w.setProps({ messages: [mine('m1'), message({ id: 'm2', text: 'new' })] });
		await flushPromises();
		expect(chat.scrollTop).toBe(120);
		expect(w.find('.message-edit textarea').exists()).toBe(true);
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
