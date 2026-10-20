// @vitest-environment jsdom
// Photo-only messages update the header without announcing the change in chat.
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

describe('photo-only messages stay out of the chat feed', () => {
	it('hides an update, a removal, and an old multi-photo message', () => {
		for (const parts of [[avatar('a')], [{ kind: 'avatar_removed', avatarId: id('a') }], [avatar('a'), avatar('b')]]) {
			const w = render([message(parts)]);
			expect(w.find('.message-bubble').exists()).toBe(false);
			expect(w.text()).not.toContain('updated their photo');
		}
	});

	it('hides an outgoing photo while syncing, but shows a failed one', () => {
		expect(render([message([avatar('a')], { isMine: true, _verify: 'waiting', _syncStatus: 'syncing' })]).find('.message-bubble').exists()).toBe(false);
		expect(render([message([avatar('a')], { isMine: true, _verify: 'waiting', _syncStatus: 'error' })]).find('.message-bubble').exists()).toBe(true);
	});

	it('hides a waiting photo, but shows blocked or invalid data', () => {
		const asked = [];
		const avatarSrc = (p) => { asked.push(p); return 'blob:x'; };
		expect(render([message([avatar('a')], { _verify: 'waiting' })]).find('.message-bubble').exists()).toBe(false);
		for (const state of ['blocked', 'invalid']) {
			const w = render([message([avatar('a')], { _verify: state })], { avatarSrc });
			expect(w.find('.message-bubble').text()).toContain('🖼 profile photo');
		}
		expect(asked).toEqual([]);
	});

	it('anything else in the message keeps the bubble, and a deleted one reads as deleted', () => {
		const mixed = render([message([avatar('a'), { kind: 'text', text: 'new me' }], { text: '🖼 profile photo\nnew me' })]);
		expect(mixed.find('.message-bubble').exists()).toBe(true);
		const deleted = render([message([], { _deleted: true, text: '' })]);
		expect(deleted.text()).toContain('Message deleted');
	});
});

describe('a gallery access grant has no chat row', () => {
	const KEY = 'B'.repeat(42) + 'w';
	const grant = { kind: 'avatar_gallery_access', version: 1, galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: KEY };
	const unreadable = { kind: 'unknown', type: 'avatar_gallery_access', value: [2, 'x', KEY] };

	it('hides a grant-only message, readable or not, verified or not', () => {
		for (const parts of [[grant], [unreadable]]) {
			for (const over of [{}, { _verify: 'invalid' }, { _verify: 'blocked' }, { isMine: true, _syncStatus: 'error' }]) {
				const w = render([message(parts, { text: '', ...over })]);
				expect(w.find('.message-bubble').exists()).toBe(false);
				expect(w.html()).not.toContain(KEY);
			}
		}
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
