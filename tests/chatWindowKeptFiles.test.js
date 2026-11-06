// @vitest-environment jsdom
// What the chat says about a file and its copy on this device, on the file
// row's meta line: kept and still on the server; kept and deleted there, so
// only this device has it; deleted and not kept; and a deleted message whose
// file this account kept.
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { fileKey } from '@/lib/data/fileKey';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const PEER = 'u_' + 'b'.repeat(128);
const FILE = { kind: 'file', fileId: 'f_' + '1'.repeat(32), uploaderHash: PEER, name: 'report.pdf', size: 2048, mimeType: 'application/pdf', encSecretB64: 'c2VjcmV0' };
const KEY = fileKey(FILE);
const ENTRY = { ...FILE, fileKey: KEY, messageId: 'dmsg_1', chunkHashes: ['fd_x'] };

const message = (over = {}) => ({
	id: 'dmsg_1',
	text: '',
	parts: [FILE],
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	_syncStatus: 'synced',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
	...over,
});

const render = (props, msg = message()) =>
	mount(ChatWindow, {
		props: { title: 'Peer', myHash: 'u_' + 'a'.repeat(128), messages: [msg], reactions: {}, ...props },
		global: { stubs: { Avatar: true } },
	});

const deletedOnServer = { [KEY]: { present: 0, total: 1, unknown: false, deleted: true } };
const meta = (w) => w.find('.msg-file-meta').text();

describe('a file kept on this device, in the chat', () => {
	it('shows the File state marker in the meta line after an ordinary download', async () => {
		const w = render({ downloads: { [KEY]: { status: 'done' } } });
		expect(meta(w)).toContain('2 KB · saved');
		expect(w.find('.msg-file-state').exists()).toBe(false);
		const marker = w.find('.msg-file-meta .msg-file-state-marker');
		expect(marker.exists()).toBe(true);
		await marker.trigger('click');
		expect(w.emitted('showFileState')?.[0]?.[0]).toEqual(FILE);
		expect(w.emitted('downloadFile')).toBeUndefined();
		await w.find('.msg-file-body').trigger('keydown.enter');
		expect(w.emitted('showFileState')).toHaveLength(2);
		await w.find('.msg-file-action').trigger('click');
		expect(w.emitted('downloadFile')).toHaveLength(1);
	});

	it('uses the same meta-line marker for audio, and media buttons for images and video', () => {
		const audio = render({}, message({ parts: [{ ...FILE, mimeType: 'audio/mpeg', name: 'voice.mp3' }] }));
		expect(audio.find('.msg-file-meta .msg-file-state-marker').exists()).toBe(true);
		for (const kind of ['image', 'video']) {
			const media = render({}, message({ parts: [{ ...FILE, kind, name: `${kind}.bin` }] }));
			expect(media.find('.msg-media-state').exists()).toBe(true);
			expect(media.find('.msg-file-state-marker').exists()).toBe(false);
		}
	});

	it('kept, on the server: a marker on the meta line', () => {
		const w = render({ kept: { [KEY]: ENTRY } });
		expect(meta(w)).toBe('2 KB · kept on this device');
		expect(w.find('.msg-file-state-marker').exists()).toBe(true);
	});

	it('kept, while the node holds only part of it: whole on this device, so no "arrives later"', () => {
		const w = render({ kept: { [KEY]: ENTRY }, availability: { [KEY]: { present: 1, total: 3, unknown: false, deleted: false } } });
		expect(w.text()).not.toContain('arrives later');
		expect(render({ availability: { [KEY]: { present: 1, total: 3, unknown: false, deleted: false } } }).text()).toContain('1 of 3 chunks here');
	});

	it('kept, deleted on the server: only this device has it, and it still opens', () => {
		const w = render({ kept: { [KEY]: ENTRY }, availability: deletedOnServer });
		expect(meta(w)).toBe('2 KB · kept · deleted on the server, only this device has it');
		expect(w.find('.msg-file-action').exists()).toBe(true);
	});

	it('deleted on the server and not kept: says so instead of "download failed", and offers no retry', () => {
		const w = render({ availability: deletedOnServer, downloads: { [KEY]: { status: 'error' } } });
		expect(meta(w)).toBe('2 KB · deleted by the sender');
		expect(w.find('.msg-file-action').exists()).toBe(false);
	});

	it('message deleted, copy kept: the kept file still has its row in the deleted message', async () => {
		const w = render({ kept: { [KEY]: ENTRY }, keptByMessage: { dmsg_1: [ENTRY] } }, message({ parts: [], _deleted: true }));
		expect(w.text()).toContain('Message deleted');
		expect(w.find('.msg-file-name').text()).toBe('report.pdf');
		expect(meta(w)).toBe('2 KB · message deleted, copy kept on this device');
		await w.find('.msg-file-action').trigger('click');
		const [[part]] = w.emitted('downloadFile');
		expect(fileKey(part)).toBe(KEY);
		expect(part.encSecretB64).toBe(FILE.encSecretB64);
	});

	it('a deleted message with nothing kept shows no file', () => {
		const w = render({}, message({ parts: [], _deleted: true }));
		expect(w.find('.msg-file').exists()).toBe(false);
	});

	it('while keeping: progress in chunks', () => {
		expect(meta(render({ keeping: { [KEY]: { done: 1, total: 3 } } }))).toBe('2 KB · keeping, chunk 1 of 3');
	});
});
