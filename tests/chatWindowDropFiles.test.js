// @vitest-environment jsdom
// Files dropped over an open dialog, or pasted into its input, send as the
// attach button does: one composed message, captioned by the input
// (docs/backlog.md §9).
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);

const render = (extra = { peerHash: PEER }) =>
	mount(ChatWindow, {
		props: { title: 'Ирина', myHash: MY, messages: [], reactions: {}, ...extra },
		global: { stubs: { Avatar: true } },
	});

const file = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });

/** A DataTransfer as a desktop browser builds it for dropped files; `folders` names entries that are directories. */
const transferOf = (files, folders = []) => ({
	types: ['Files'],
	files,
	items: files.map((f) => ({ webkitGetAsEntry: () => ({ isDirectory: folders.includes(f.name) }) })),
	dropEffect: 'none',
});

const dragEvent = async (wrapper, type, dataTransfer) => {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
	wrapper.element.dispatchEvent(event);
	await wrapper.vm.$nextTick();
	return event;
};

describe('dropping files over a dialog', () => {
	it('sends them as one message with the caption from the input, and clears it', async () => {
		const w = render();
		await w.find('input[type="text"]').setValue('акты за сентябрь');
		const files = [file('a.pdf'), file('b.pdf')];
		await dragEvent(w, 'dragenter', transferOf(files));
		expect(w.find('.drop-overlay').text()).toBe('Drop to send to Ирина');
		const drop = await dragEvent(w, 'drop', transferOf(files));
		expect(drop.defaultPrevented).toBe(true);
		expect(w.find('.drop-overlay').exists()).toBe(false);
		const [sent, caption] = w.emitted('sendFile')[0];
		expect(sent.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
		expect(caption).toBe('акты за сентябрь');
		expect(w.find('input[type="text"]').element.value).toBe('');
	});

	it('cancels dragover, so the browser does not open the file in place of the app', async () => {
		const w = render();
		const over = await dragEvent(w, 'dragover', transferOf([file('a.pdf')]));
		expect(over.defaultPrevented).toBe(true);
	});

	it('hides the overlay once the drag leaves the pane, counting the children it crossed', async () => {
		const w = render();
		const t = transferOf([file('a.pdf')]);
		await dragEvent(w, 'dragenter', t);
		await dragEvent(w, 'dragenter', t); // over a child
		await dragEvent(w, 'dragleave', t); // out of the child
		expect(w.find('.drop-overlay').exists()).toBe(true);
		await dragEvent(w, 'dragleave', t); // out of the pane
		expect(w.find('.drop-overlay').exists()).toBe(false);
	});

	it('leaves a drag that carries no files alone: dragged text, links, the upload queue', async () => {
		const w = render();
		const text = { types: ['text/plain'], files: [], items: [] };
		const over = await dragEvent(w, 'dragover', text);
		await dragEvent(w, 'drop', text);
		expect(over.defaultPrevented).toBe(false);
		expect(w.find('.drop-overlay').exists()).toBe(false);
		expect(w.emitted('sendFile')).toBeUndefined();
	});

	it('names a dropped folder and sends the files beside it', async () => {
		const w = render();
		await dragEvent(w, 'drop', transferOf([file('photos'), file('note.txt')], ['photos']));
		expect(w.emitted('sendFile')[0][0].map((f) => f.name)).toEqual(['note.txt']);
		expect(w.find('.drop-notice').text()).toContain('photos');
	});
});

describe('pasting into the input', () => {
	it('sends a pasted screenshot', async () => {
		const w = render();
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: { files: [file('shot.png')] } });
		w.find('input[type="text"]').element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(w.emitted('sendFile')[0][0].map((f) => f.name)).toEqual(['shot.png']);
	});

	it('leaves pasted text to the input', async () => {
		const w = render();
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: { files: [] } });
		w.find('input[type="text"]').element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(w.emitted('sendFile')).toBeUndefined();
	});
});

describe('a room, which has no peer and takes no files', () => {
	it('has no attach button and is no drop target, yet a dropped file still does not replace the app', async () => {
		const w = render({});
		expect(w.find('.attach-btn').exists()).toBe(false);
		const t = transferOf([file('a.pdf')]);
		await dragEvent(w, 'dragenter', t);
		expect(w.find('.drop-overlay').exists()).toBe(false);
		const over = await dragEvent(w, 'dragover', t);
		expect(over.defaultPrevented).toBe(true);
		expect(t.dropEffect).toBe('none');
		await dragEvent(w, 'drop', t);
		expect(w.emitted('sendFile')).toBeUndefined();
	});
});

describe('the attach button', () => {
	it('draws the line paperclip of the UI icon set, not an emoji', () => {
		const w = render();
		expect(w.find('.attach-btn i.bi.bi-paperclip').exists()).toBe(true);
		expect(w.find('.attach-btn').text()).toBe('');
	});
});
