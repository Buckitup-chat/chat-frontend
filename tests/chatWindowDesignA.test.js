// @vitest-environment jsdom
// Design board "Chat Attachments States", stage A: quotes (§1.2), deletion
// tombstone (§3.2), send-state badges (§4.3), unplaced messages (§4.2).
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);

const message = (over = {}) => ({
	id: 'dmsg_1',
	text: 'hello',
	parts: [{ kind: 'text', text: 'hello' }],
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	_syncStatus: 'synced',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
	...over,
});

const quotePart = (over = {}) => ({
	kind: 'quote',
	authorHash: PEER,
	messageId: 'dmsg_orig',
	signHash: 'dms_' + '2'.repeat(128),
	snapshot: [{ kind: 'text', text: 'Схему пришли до четверга' }],
	...over,
});

const render = (messages) =>
	mount(ChatWindow, {
		props: { title: 'Ирина', myHash: MY, messages, reactions: {} },
		global: { stubs: { Avatar: true } },
	});

describe('§1.2 quotes render from their own snapshot', () => {
	it('shows the quoted author and the snapshot text', () => {
		const w = render([message({ parts: [quotePart(), { kind: 'text', text: 'Уже в очереди' }], text: 'Уже в очереди' })]);
		const quote = w.find('.msg-quote');
		expect(quote.exists()).toBe(true);
		expect(quote.find('.msg-quote-author').text()).toBe('Ирина');
		expect(quote.find('.msg-quote-text').text()).toContain('Схему пришли до четверга');
	});

	it('names my own quoted message "Me"', () => {
		const w = render([message({ parts: [quotePart({ authorHash: MY })], text: '' })]);
		expect(w.find('.msg-quote-author').text()).toBe('Me');
	});

	// The whole reason the snapshot travels in the reply: the original may
	// simply not have replicated here yet, and the quote still reads.
	it('renders the quote with an honest note when the original is absent', () => {
		const w = render([message({ parts: [quotePart()], text: 'ответ' })]);
		expect(w.find('.msg-quote-text').text()).toContain('Схему пришли');
		expect(w.find('.msg-quote-note').text()).toMatch(/not synced yet/);
	});

	it('turns historical when the original was deleted', () => {
		const orig = message({ id: 'dmsg_orig', _deleted: true, text: '', _raw: { message_id: 'dmsg_orig', sign_hash: 'dms_x', sender_hash: PEER } });
		const reply = message({ id: 'dmsg_2', parts: [quotePart()], text: 'ответ', _raw: { message_id: 'dmsg_2', sign_hash: 'dms_y', sender_hash: PEER } });
		const w = render([orig, reply]);
		expect(w.find('.msg-quote._historic').exists()).toBe(true);
		expect(w.find('.msg-quote-note').text()).toMatch(/deleted by author/);
	});
});

describe('reply flow', () => {
	it('offers Reply in the context menu and emits the quote with the send', async () => {
		const w = render([message()]);
		await w.findAll('.message-bubble')[0].trigger('contextmenu');
		const reply = w.findAll('.context-menu-action').find((b) => b.text().includes('Reply'));
		expect(reply).toBeTruthy();
		await reply.trigger('click');

		expect(w.find('.reply-preview').exists()).toBe(true);

		await w.find('input[type="text"]').setValue('Уже в очереди');
		await w.find('form').trigger('submit');

		const [text, replyTo] = w.emitted('sendMessage')[0];
		expect(text).toBe('Уже в очереди');
		expect(replyTo).toMatchObject({ messageId: 'dmsg_1', authorHash: PEER });
		expect(replyTo.snapshot).toEqual([{ kind: 'text', text: 'hello' }]);
		// preview cleared after sending — the next message is not a reply
		expect(w.find('.reply-preview').exists()).toBe(false);
	});

	it('does not offer Reply on a tombstone', async () => {
		const w = render([message({ _deleted: true, text: '' })]);
		await w.findAll('.message-bubble')[0].trigger('contextmenu');
		const reply = w.findAll('.context-menu-action').find((b) => b.text().includes('Reply'));
		expect(reply).toBeFalsy();
	});
});

describe('§3.2 deletion tombstone', () => {
	it('shows the tombstone line instead of content', () => {
		const w = render([message({ _deleted: true, text: 'должно не показаться' })]);
		expect(w.text()).toContain('Message deleted');
		expect(w.text()).not.toContain('должно не показаться');
	});
});

describe('§4.3 send-state badges', () => {
	it('◌ for stored locally', () => {
		const w = render([message({ isMine: true, _syncStatus: 'sending' })]);
		expect(w.find('.sync-status.local').text()).toBe('◌');
	});

	it('pale ✓ in flight, plain ✓ accepted', () => {
		expect(render([message({ isMine: true, _syncStatus: 'syncing' })]).find('.sync-status.pending').exists()).toBe(true);
		expect(render([message({ isMine: true, _syncStatus: 'synced' })]).find('.sync-status.synced').exists()).toBe(true);
	});

	it('rejected: red frame on the bubble and ! badge', () => {
		const w = render([message({ isMine: true, _syncStatus: 'error' })]);
		expect(w.find('.message-bubble.message-error').exists()).toBe(true);
		expect(w.find('.sync-status.error').exists()).toBe(true);
	});

	it('marks an edited message', () => {
		const w = render([message({ _raw: { message_id: 'dmsg_1', sign_hash: 'dms_z', sender_hash: PEER, parent_sign_hash: 'dms_' + '9'.repeat(128) } })]);
		expect(w.find('.msg-edited').exists()).toBe(true);
	});
});

describe('§4.2 causally unplaced', () => {
	it('dims the bubble and says why', () => {
		const w = render([message({ _verify: 'waiting' })]);
		expect(w.find('.message-bubble.message-unplaced').exists()).toBe(true);
		expect(w.find('.msg-unplaced-note').text()).toMatch(/waiting for earlier/);
	});

	it('no note on a verified message', () => {
		const w = render([message({ _verify: 'verified' })]);
		expect(w.find('.msg-unplaced-note').exists()).toBe(false);
	});
});
