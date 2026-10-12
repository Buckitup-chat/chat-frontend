// @vitest-environment jsdom
// pq_avatars in the feed: a profile-photo message is a compact service line,
// not a text bubble, and the peer's picture opens their gallery.
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const id = (c) => c.repeat(32);
const photo = { kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: 'avatar.jpg', size: 1, mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + '1'.repeat(32), encSecretB64: 'k' };
const avatar = (c) => ({ kind: 'avatar', avatarId: id(c), photo });

const message = (parts, over = {}) => ({
	id: 'dmsg_1', text: '🖼 profile photo', parts, authorName: 'Ирина', isMine: false, timestamp: '10:00', _syncStatus: 'synced',
	_verify: 'verified',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
	...over,
});

const render = (messages, props = {}) => mount(ChatWindow, {
	props: { title: 'Ирина', myHash: MY, peerHash: PEER, messages, reactions: {}, ...props },
	global: { stubs: { Avatar: true } },
});

describe('profile-photo messages render as a service line', () => {
	it('names who changed their photo, not a bubble', () => {
		const w = render([message([avatar('a')])]);
		expect(w.find('.msg-avatar-line').text()).toBe('Ирина updated their photo');
		expect(w.find('.message-bubble').exists()).toBe(false);
	});

	it('words the own change, a removal, and a whole gallery', () => {
		expect(render([message([avatar('a')], { isMine: true })]).find('.msg-avatar-line').text()).toBe('You updated your photo');
		expect(render([message([{ kind: 'avatar_removed', avatarId: id('a') }])]).find('.msg-avatar-line').text()).toBe('Ирина removed a photo');
		expect(render([message([avatar('a'), avatar('b'), avatar('c')])]).find('.msg-avatar-line').text()).toBe('Ирина shared 3 profile photos');
	});

	it('shows the decrypted photo when the page has it, the newest one of the message, as its sender\'s', () => {
		const asked = [];
		const avatarSrc = (photo, sender) => { asked.push(sender); return `blob:${photo.name}`; };
		const w = render([message([avatar('a'), { ...avatar('b'), photo: { ...photo, name: 'b.jpg' } }])], { avatarSrc });
		expect(w.find('.msg-avatar-thumb').attributes('src')).toBe('blob:b.jpg');
		expect(new Set(asked)).toEqual(new Set([PEER]));
	});

	it('draws nothing where neither the photo nor a blur is there yet', () => {
		const w = render([message([avatar('a')])]);
		expect(w.find('.msg-avatar-thumb').exists()).toBe(false);
	});

	it('a tap opens the sender\'s gallery at that photo', async () => {
		const w = render([message([avatar('a')])]);
		await w.find('.msg-avatar-chip').trigger('click');
		expect(w.emitted('showAvatar')[0][0]).toEqual({ senderHash: PEER, avatarId: id('a') });
	});

	it('anything else in the message keeps the bubble, and a deleted one reads as deleted', () => {
		const mixed = render([message([avatar('a'), { kind: 'text', text: 'new me' }], { text: '🖼 profile photo\nnew me' })]);
		expect(mixed.find('.msg-avatar-line').exists()).toBe(false);
		expect(mixed.find('.message-bubble').exists()).toBe(true);
		const deleted = render([message([], { _deleted: true, text: '' })]);
		expect(deleted.find('.msg-avatar-line').exists()).toBe(false);
		expect(deleted.text()).toContain('Message deleted');
	});

	it('cannot be edited into text: the context menu offers no Edit', async () => {
		const w = render([message([avatar('a')], { isMine: true, _raw: { message_id: 'dmsg_1', sign_hash: 'dms_1', sender_hash: MY } })]);
		await w.find('.msg-avatar-line').trigger('contextmenu');
		expect(w.find('.context-menu').exists()).toBe(true);
		expect(w.find('.context-menu').text()).not.toContain('Edit');
		expect(w.find('.context-menu').text()).toContain('Delete');
	});
});

describe('the chat header picture', () => {
	it('opens the peer\'s gallery', async () => {
		const w = render([]);
		await w.find('.chat-header .avatar').trigger('click');
		expect(w.emitted('showAvatar')[0][0]).toEqual({ senderHash: PEER });
	});

	it('does nothing in a room, which has no peer', async () => {
		const w = render([], { peerHash: '' });
		await w.find('.chat-header .avatar').trigger('click');
		expect(w.emitted('showAvatar')).toBeUndefined();
	});
});
