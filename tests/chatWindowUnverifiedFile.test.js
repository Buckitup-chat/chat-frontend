// @vitest-environment jsdom
// A refused file is shown as such (docs/invariants.md §6a): "could not be
// verified", and no download button — another attempt gets the same answer.
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const PEER = 'u_' + 'b'.repeat(128);
const FILE = { kind: 'file', fileId: 'f_' + '1'.repeat(32), name: 'report.pdf', size: 2048, mimeType: 'application/pdf' };
const IMAGE = { kind: 'image', fileId: 'f_' + '2'.repeat(32), name: 'photo.jpg', size: 4096, mimeType: 'image/jpeg', widthAspect: 4, heightAspect: 3 };

const message = (parts) => ({
	id: 'dmsg_1',
	text: '',
	parts,
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	_syncStatus: 'synced',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
});

const render = (parts, props) =>
	mount(ChatWindow, {
		props: { title: 'Peer', myHash: 'u_' + 'a'.repeat(128), messages: [message(parts)], reactions: {}, ...props },
		global: { stubs: { Avatar: true } },
	});

describe('a file that could not be verified', () => {
	it('after a refused download: says so, and offers no download', () => {
		const w = render([FILE], { downloads: { [FILE.fileId]: { status: 'unverified' } } });
		expect(w.find('.msg-file-meta').text()).toContain('This file could not be verified');
		expect(w.find('.msg-file-action').exists()).toBe(false);
	});

	it('after a refused availability check: the same', () => {
		const w = render([FILE], { availability: { [FILE.fileId]: { present: 0, total: 0, unknown: false, deleted: false, unverified: true } } });
		expect(w.find('.msg-file-meta').text()).toContain('This file could not be verified');
		expect(w.find('.msg-file-action').exists()).toBe(false);
	});

	it('a download that failed on the network still offers a retry', () => {
		const w = render([FILE], { downloads: { [FILE.fileId]: { status: 'error' } } });
		expect(w.find('.msg-file-meta').text()).toContain('download failed — tap to retry');
		expect(w.find('.msg-file-action').exists()).toBe(true);
	});

	it('an image: says so in place of the picture', () => {
		const w = render([IMAGE], { images: { [IMAGE.fileId]: { status: 'unverified' } } });
		expect(w.find('.msg-image-progress').text()).toBe('This image could not be verified');
	});
});
