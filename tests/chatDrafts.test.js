// @vitest-environment jsdom
// The draft lifecycle through the real component and the real drafts module
// (only the IndexedDB layer is swapped for memory): restore on open, debounced
// save while typing, clear on send, flush-and-restore on a dialog switch.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { _setStoreForTests } from '@/lib/data/localStore';

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const PEER2 = 'u_' + 'c'.repeat(128);

const draftKey = (peer) => `draft|${MY}|${peer}`;

let mem;
beforeEach(() => {
	mem = new Map();
	_setStoreForTests({
		async get(k) { return mem.get(k) ?? null; },
		async set(k, v) { mem.set(k, v); },
		async delete(k) { mem.delete(k); },
		async keys() { return [...mem.keys()]; },
		async clear() { mem.clear(); },
	});
});

const seed = (peer, draft) => mem.set(draftKey(peer), JSON.stringify(draft));
const stored = (peer) => (mem.has(draftKey(peer)) ? JSON.parse(mem.get(draftKey(peer))) : null);

const mountChat = (peerHash = PEER) =>
	mount(ChatWindow, {
		props: { title: 'Ирина', myHash: MY, peerHash, messages: [], reactions: {} },
		global: { stubs: { Avatar: true } },
	});

const flush = () => new Promise((r) => setTimeout(r));

describe('input drafts', () => {
	it('restores the stored draft into the input on open', async () => {
		seed(PEER, { text: 'я как раз хотел ска', replyTo: null, savedAt: 1 });
		const w = mountChat();
		await vi.waitFor(() =>
			expect(w.find('input[type="text"]').element.value).toBe('я как раз хотел ска'));
	});

	it('restores the reply context along with the text', async () => {
		seed(PEER, {
			text: 'отвечаю…',
			replyTo: { messageId: 'dmsg_1', signHash: 'dms_x', authorHash: PEER, snapshot: [], previewText: 'исходник' },
			savedAt: 1,
		});
		const w = mountChat();
		await vi.waitFor(() => expect(w.find('.reply-preview').exists()).toBe(true));
		expect(w.find('.reply-preview').text()).toContain('исходник');
	});

	it('saves after the debounce while typing', async () => {
		vi.useFakeTimers();
		try {
			const w = mountChat();
			await vi.advanceTimersByTimeAsync(0); // restore settles first
			await w.find('input[type="text"]').setValue('недописанное сообщение');
			await vi.advanceTimersByTimeAsync(400);
			expect(stored(PEER)?.text).toBe('недописанное сообщение');
		} finally {
			vi.useRealTimers();
		}
	});

	it('sending clears the draft', async () => {
		seed(PEER, { text: 'готово к отправке', replyTo: null, savedAt: 1 });
		const w = mountChat();
		await vi.waitFor(() => expect(w.find('input[type="text"]').element.value).toBe('готово к отправке'));
		await w.find('form').trigger('submit');
		await flush();
		expect(w.emitted('sendMessage')[0][0]).toBe('готово к отправке');
		expect(stored(PEER)).toBe(null);
	});

	it('a dialog switch flushes the outgoing draft and restores the incoming one', async () => {
		seed(PEER2, { text: 'черновик второго диалога', replyTo: null, savedAt: 1 });
		const w = mountChat();
		await flush();
		await w.find('input[type="text"]').setValue('первому, не дописано');
		await w.setProps({ peerHash: PEER2 });
		await vi.waitFor(() => {
			expect(stored(PEER)?.text).toBe('первому, не дописано'); // saved without waiting out the debounce
			expect(w.find('input[type="text"]').element.value).toBe('черновик второго диалога');
		});
	});

	it('unmount flushes the pending draft', async () => {
		const w = mountChat();
		await flush();
		await w.find('input[type="text"]').setValue('уходя, сохраняюсь');
		w.unmount();
		await vi.waitFor(() => expect(stored(PEER)?.text).toBe('уходя, сохраняюсь'));
	});
});
