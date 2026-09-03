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

describe('§3.1 version history', () => {
	const edited = (over = {}) =>
		message({
			_raw: { message_id: 'dmsg_1', sign_hash: 'dms_tip', sender_hash: PEER, parent_sign_hash: 'dms_prev' },
			...over,
		});

	const renderWith = (messages, extra = {}) =>
		mount(ChatWindow, {
			props: { title: 'Ирина', myHash: MY, messages, reactions: {}, ...extra },
			global: { stubs: { Avatar: true } },
		});

	it('the edited label carries the version count and opens history', async () => {
		const w = renderWith([edited()], { versionCounts: { dmsg_1: 2 } });
		const label = w.find('.msg-edited');
		expect(label.text()).toContain('edited · 2');

		await label.trigger('click');
		expect(w.emitted('showHistory')[0]).toEqual(['dmsg_1']);
		expect(w.find('.msg-history').exists()).toBe(true);
	});

	it('renders past revisions struck through with the historical tag', async () => {
		const w = renderWith([edited()], {
			versionCounts: { dmsg_1: 1 },
			histories: { dmsg_1: [{ signHash: 'dms_prev', ownerTimestamp: 1, deletedFlag: false, verified: true, text: 'старый текст' }] },
		});
		await w.find('.msg-edited').trigger('click');
		const item = w.find('.msg-history-item');
		expect(item.find('.msg-history-tag').text()).toMatch(/historical/i);
		expect(item.find('.msg-history-text').text()).toBe('старый текст');
	});

	// History is lineage, not a cache: a revision that fails verification is
	// shown AS unverifiable, not silently dropped and not shown as content.
	it('marks an unverifiable revision instead of dropping it', async () => {
		const w = renderWith([edited()], {
			histories: { dmsg_1: [{ signHash: 'dms_bad', ownerTimestamp: 1, deletedFlag: false, verified: false, text: 'Unverifiable revision' }] },
		});
		await w.find('.msg-edited').trigger('click');
		expect(w.find('.msg-history-text._unverified').exists()).toBe(true);
	});

	it('toggles closed without re-requesting', async () => {
		const w = renderWith([edited()], { histories: { dmsg_1: [] } });
		await w.find('.msg-edited').trigger('click');
		await w.find('.msg-edited').trigger('click');
		expect(w.find('.msg-history').exists()).toBe(false);
		expect(w.emitted('showHistory')).toHaveLength(1);
	});
});

describe('§3.2 delete action', () => {
	it('offers Delete only on own synced messages and emits after confirm', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const w = render([message({ isMine: true, _syncStatus: 'synced' })]);
		await w.findAll('.message-bubble')[0].trigger('contextmenu');
		const del = w.findAll('.context-menu-action').find((b) => b.text().includes('Delete'));
		expect(del).toBeTruthy();
		await del.trigger('click');
		expect(w.emitted('deleteMessage')[0]).toEqual(['dmsg_1']);
		confirmSpy.mockRestore();
	});

	it('does not emit when the confirm is declined', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
		const w = render([message({ isMine: true, _syncStatus: 'synced' })]);
		await w.findAll('.message-bubble')[0].trigger('contextmenu');
		await w.findAll('.context-menu-action').find((b) => b.text().includes('Delete')).trigger('click');
		expect(w.emitted('deleteMessage')).toBeFalsy();
		confirmSpy.mockRestore();
	});

	it('offers no Delete on peer messages or tombstones', async () => {
		for (const msg of [message({ isMine: false }), message({ isMine: true, _deleted: true })]) {
			const w = render([msg]);
			await w.findAll('.message-bubble')[0].trigger('contextmenu');
			expect(w.findAll('.context-menu-action').find((b) => b.text().includes('Delete'))).toBeFalsy();
		}
	});
});

describe('§1.5 file attachments', () => {
	const filePart = (over = {}) => ({
		kind: 'file', name: 'act-2026-08.pdf', size: 64_700_000, mimeType: 'application/pdf',
		createdAt: 1715000000, fileId: 'f_' + 'a'.repeat(32), encSecretB64: 'AAAA', ...over,
	});
	const renderWith = (messages, extra = {}) =>
		mount(ChatWindow, {
			props: { title: 'Ирина', myHash: MY, messages, reactions: {}, ...extra },
			global: { stubs: { Avatar: true } },
		});

	it('renders the file row with name and human size', () => {
		const w = renderWith([message({ parts: [filePart()], text: '' })]);
		const row = w.find('.msg-file');
		expect(row.find('.msg-file-name').text()).toBe('act-2026-08.pdf');
		expect(row.find('.msg-file-meta').text()).toContain('61.7 MB');
	});

	it('shows chunk progress while downloading — chunks, not percentages', () => {
		const w = renderWith([message({ parts: [filePart()], text: '' })], {
			downloads: { ['f_' + 'a'.repeat(32)]: { status: 'downloading', done: 5, total: 12 } },
		});
		expect(w.find('.msg-file-meta').text()).toContain('chunk 5 of 12');
		expect(w.find('.msg-file-spinner').exists()).toBe(true);
	});

	it('emits downloadFile with the part on tap', async () => {
		const w = renderWith([message({ parts: [filePart()], text: '' })]);
		await w.find('.msg-file-action').trigger('click');
		expect(w.emitted('downloadFile')[0][0]).toMatchObject({ fileId: 'f_' + 'a'.repeat(32) });
	});

	it('upload strip shows chunk progress and cancels', async () => {
		const w = renderWith([], { uploads: [{ id: 'up_1', name: 'mesh-dump.tar', done: 9, total: 14, status: 'uploading' }] });
		const strip = w.find('.upload-strip');
		expect(strip.text()).toContain('chunk 9 of 14');
		await strip.find('button').trigger('click');
		expect(w.emitted('cancelUpload')[0]).toEqual(['up_1']);
	});

	it('attach button emits the picked file with the caption from the input', async () => {
		const w = renderWith([]);
		await w.find('input[type="text"]').setValue('вот акт');
		const file = new File([new Uint8Array([1, 2, 3])], 'act.pdf', { type: 'application/pdf' });
		const input = w.find('input[type="file"]');
		Object.defineProperty(input.element, 'files', { value: [file] });
		await input.trigger('change');
		const [emitted, caption] = w.emitted('sendFile')[0];
		expect(emitted.name).toBe('act.pdf');
		expect(caption).toBe('вот акт');
		expect(w.find('input[type="text"]').element.value).toBe('');
	});
});
