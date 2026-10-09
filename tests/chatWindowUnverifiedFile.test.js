// @vitest-environment jsdom
// A refused file is shown as such wherever it appears (docs/invariants.md §6a):
// "could not be verified", and nothing that would start it again — another
// attempt gets the same answer.
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import FileStateModal from '@/components/chat/FileStateModal.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const PEER = 'u_' + 'b'.repeat(128);
const FILE = { kind: 'file', fileId: 'f_' + '1'.repeat(32), name: 'report.pdf', size: 2048, mimeType: 'application/pdf' };
const image = (n) => ({ kind: 'image', fileId: 'f_' + String(n).repeat(32), name: `photo${n}.jpg`, size: 4096, mimeType: 'image/jpeg', widthAspect: 4, heightAspect: 3 });
const VIDEO = { kind: 'video', fileId: 'f_' + '9'.repeat(32), name: 'clip.mp4', size: 8192, mimeType: 'video/mp4', widthAspect: 16, heightAspect: 9 };

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
	it('a file row: says so, and offers no download', () => {
		const w = render([FILE], { refused: { [FILE.fileId]: true } });
		expect(w.find('.msg-file-meta').text()).toContain('This file could not be verified');
		expect(w.find('.msg-file-action').exists()).toBe(false);
	});

	it('a download that failed on the network still offers a retry', () => {
		const w = render([FILE], { downloads: { [FILE.fileId]: { status: 'error' } } });
		expect(w.find('.msg-file-meta').text()).toContain('download failed — tap to retry');
		expect(w.find('.msg-file-action').exists()).toBe(true);
	});

	it('a single image: says so in place of the picture', () => {
		const im = image(2);
		const w = render([im], { refused: { [im.fileId]: true } });
		expect(w.find('.msg-image-progress').text()).toBe('This image could not be verified');
	});

	it('an image in a grid: says so on its cell', () => {
		const [a, b] = [image(3), image(4)];
		const w = render([a, b], { refused: { [b.fileId]: true } });
		const cells = w.findAll('.msg-gallery-cell');
		expect(cells[0].find('.msg-image-progress').exists()).toBe(false);
		expect(cells[1].find('.msg-image-progress').text()).toBe('could not be verified');
	});

	it('a video: says so, and a tap does not open it again', async () => {
		const w = render([VIDEO], { refused: { [VIDEO.fileId]: true } });
		expect(w.find('.msg-video .msg-image-progress').text()).toBe('This video could not be verified');
		await w.find('.msg-video-frame').trigger('click');
		expect(w.emitted('playVideo')).toBeUndefined();
	});
});

describe('the file state screen of a refused file', () => {
	it('says so instead of counting chunks, and has no download button', () => {
		const w = mount(FileStateModal, { props: { part: FILE, availability: { present: 2, total: 2, unknown: false, deleted: false }, refused: true } });
		expect(w.find('.fs-refused').text()).toContain('This file could not be verified');
		expect(w.find('.fs-btn').exists()).toBe(false);
		expect(w.find('.fs-chunks').exists()).toBe(false);
	});
});
