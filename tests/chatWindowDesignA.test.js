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

	// Board screen 02: several files, one composed message, the caption from
	// the same input.
	it('attach button emits everything picked with the caption from the input', async () => {
		const w = renderWith([]);
		await w.find('input[type="text"]').setValue('схема и акт');
		const input = w.find('input[type="file"]');
		expect(input.attributes('multiple')).toBeDefined();
		const files = [
			new File([new Uint8Array([1])], 'scheme.jpg', { type: 'image/jpeg' }),
			new File([new Uint8Array([2])], 'act.pdf', { type: 'application/pdf' }),
		];
		Object.defineProperty(input.element, 'files', { value: files });
		await input.trigger('change');
		const [emitted, caption] = w.emitted('sendFile')[0];
		expect(emitted.map((f) => f.name)).toEqual(['scheme.jpg', 'act.pdf']);
		expect(caption).toBe('схема и акт');
		expect(w.find('input[type="text"]').element.value).toBe('');
	});
});

describe('§1.3 images', () => {
	const imagePart = (over = {}) => ({
		kind: 'image', widthAspect: 3, heightAspect: 4, thumbHashB64: '',
		name: 'shot.png', size: 121_000, mimeType: 'image/png',
		createdAt: 1715000000, fileId: 'f_' + 'c'.repeat(32), encSecretB64: 'AAAA', ...over,
	});
	const renderWith = (messages, extra = {}) =>
		mount(ChatWindow, {
			props: { title: 'Ирина', myHash: MY, messages, reactions: {}, ...extra },
			global: { stubs: { Avatar: true } },
		});

	// The bubble must not jump when the bytes land, so the box is reserved
	// from the aspect ratio the message carries.
	it('reserves the picture box from the declared aspect ratio', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })]);
		const box = w.find('.msg-image');
		expect(box.exists()).toBe(true);
		expect(box.attributes('style')).toContain('aspect-ratio: 3 / 4');
	});

	it('shows chunk progress over the placeholder while fetching', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })], {
			images: { ['f_' + 'c'.repeat(32)]: { status: 'downloading', done: 3, total: 8 } },
		});
		expect(w.find('.msg-image-progress').text()).toBe('3 / 8 chunks');
		expect(w.find('.msg-image-full').exists()).toBe(false);
	});

	it('renders the decrypted image once it is there', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })], {
			images: { ['f_' + 'c'.repeat(32)]: { status: 'done', url: 'blob:x' } },
		});
		const img = w.find('.msg-image-full');
		expect(img.attributes('src')).toBe('blob:x');
		expect(img.attributes('alt')).toBe('shot.png');
	});

	it('offers a retry when the image failed', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })], {
			images: { ['f_' + 'c'.repeat(32)]: { status: 'error' } },
		});
		expect(w.find('.msg-image-progress._err').text()).toMatch(/tap to retry/);
	});

	it('renders an image as a picture, not as a file row', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })]);
		expect(w.find('.msg-image').exists()).toBe(true);
		expect(w.find('.msg-file').exists()).toBe(false);
	});

	// The filename used to be printed under the attachment as body text.
	it('does not repeat the filename as message text', () => {
		const w = renderWith([message({ parts: [imagePart()], text: '' })]);
		expect(w.find('.message-text').text()).toBe('');
	});

	it('keeps a real caption next to the picture', () => {
		const w = renderWith([message({
			parts: [imagePart(), { kind: 'text', text: 'вот схема' }], text: 'вот схема',
		})]);
		expect(w.find('.msg-image').exists()).toBe(true);
		expect(w.find('.message-text').text()).toBe('вот схема');
	});
});

describe('§1.6 attachment grid and carousel', () => {
	const img = (i) => ({
		kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '',
		name: `p${i}.png`, size: 1000, mimeType: 'image/png', createdAt: 0,
		fileId: 'f_' + String(i).repeat(32).slice(0, 32), encSecretB64: 'AAAA',
	});
	const renderWith = (parts, extra = {}) =>
		mount(ChatWindow, {
			props: { title: 'Ирина', myHash: MY, messages: [message({ parts, text: '' })], reactions: {}, ...extra },
			global: { stubs: { Avatar: true } },
		});

	it('lays two, three and four pictures out as a grid, not stacked', () => {
		for (const [n, cls] of [[2, '_n2'], [3, '_n3'], [4, '_n4']]) {
			const w = renderWith(Array.from({ length: n }, (_, i) => img(i)));
			expect(w.find(`.msg-gallery.${cls}`).exists()).toBe(true);
			expect(w.findAll('.msg-gallery-cell')).toHaveLength(n);
		}
	});

	it('keeps a lone picture out of the grid', () => {
		const w = renderWith([img(1)]);
		expect(w.find('.msg-gallery').exists()).toBe(false);
		expect(w.find('.msg-image').exists()).toBe(true);
	});

	// Past four, the rest hide behind a counter rather than growing the grid.
	it('shows four tiles and a +N counter for larger sets', () => {
		const w = renderWith(Array.from({ length: 8 }, (_, i) => img(i)));
		expect(w.findAll('.msg-gallery-cell')).toHaveLength(4);
		expect(w.find('.msg-gallery-more').text()).toBe('+4');
	});

	it('opens the carousel on a tile, with the counter and the strip', async () => {
		const w = renderWith([img(1), img(2), img(3)]);
		await w.findAll('.msg-gallery-cell')[1].trigger('click');
		expect(w.find('.lightbox').exists()).toBe(true);
		expect(w.find('.lightbox-count').text()).toBe('2 / 3');
		expect(w.findAll('.lightbox-thumb')).toHaveLength(3);
	});

	it('steps through frames and wraps around', async () => {
		const w = renderWith([img(1), img(2)]);
		await w.findAll('.msg-gallery-cell')[0].trigger('click');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('2 / 2');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('1 / 2');
	});

	// A frame still downloading reads as dimmed, so the strip doubles as
	// "which of these are actually here".
	it('marks frames that have not arrived in the strip', async () => {
		const w = renderWith([img(1), img(2)], {
			images: { [img(1).fileId]: { status: 'done', url: 'blob:a' } },
		});
		await w.findAll('.msg-gallery-cell')[0].trigger('click');
		const thumbs = w.findAll('.lightbox-thumb');
		expect(thumbs[0].classes()).not.toContain('_pending');
		expect(thumbs[1].classes()).toContain('_pending');
	});

	it('the +N tile opens at the first hidden frame', async () => {
		const w = renderWith(Array.from({ length: 8 }, (_, i) => img(i)));
		await w.findAll('.msg-gallery-cell')[3].trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('4 / 8');
	});

	it('carries the message caption under the frame', async () => {
		const w = renderWith([img(1), img(2), { kind: 'text', text: 'вот кадры' }]);
		await w.findAll('.msg-gallery-cell')[0].trigger('click');
		expect(w.find('.lightbox-caption').text()).toBe('вот кадры');
	});
});

describe('carousel asks for the frames it shows', () => {
	const img = (i) => ({
		kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '',
		name: `p${i}.png`, size: 1, mimeType: 'image/png', createdAt: 0,
		fileId: 'f_' + String(i).repeat(32).slice(0, 32), encSecretB64: 'AAAA',
	});
	const renderWith = (parts) =>
		mount(ChatWindow, {
			props: { title: 'Ирина', myHash: MY, messages: [message({ parts, text: '' })], reactions: {} },
			global: { stubs: { Avatar: true } },
		});

	it('requests the opened frame and each one stepped to', async () => {
		const w = renderWith([img(1), img(2)]);
		await w.findAll('.msg-gallery-cell')[0].trigger('click');
		await w.find('.lightbox-nav._next').trigger('click');
		const asked = w.emitted('showImage').map(([p]) => p.name);
		expect(asked).toEqual(['p1.png', 'p2.png']);
	});
});

describe('§2.4 file availability', () => {
	const filePart = {
		kind: 'file', name: 'mesh-dump.tar', size: 64_700_000, mimeType: 'application/x-tar',
		createdAt: 0, fileId: 'f_' + 'd'.repeat(32), encSecretB64: 'AAAA',
	};
	const renderWith = (availability) =>
		mount(ChatWindow, {
			props: {
				title: 'Ирина', myHash: MY, reactions: {},
				messages: [message({ parts: [filePart], text: '' })],
				availability,
			},
			global: { stubs: { Avatar: true } },
		});

	it('shows a chunk strip with the ones that are here filled', () => {
		const w = renderWith({ [filePart.fileId]: { present: 5, total: 12, unknown: false, deleted: false } });
		const chunks = w.findAll('.msg-chunk');
		expect(chunks).toHaveLength(12);
		expect(chunks.filter((c) => c.classes().includes('_have'))).toHaveLength(5);
		expect(w.find('.msg-availability-note').text()).toContain('5 of 12 chunks here');
	});

	// Partial availability is progress, not failure: the design forbids red
	// and warning icons, and words it as "arrives later".
	it('words partial availability as arriving, not as unavailable', () => {
		const w = renderWith({ [filePart.fileId]: { present: 5, total: 12, unknown: false, deleted: false } });
		const note = w.find('.msg-availability-note');
		expect(note.text()).toMatch(/arrives later/);
		expect(note.text()).not.toMatch(/unavailable|failed|error/i);
	});

	it('says nothing when the whole file is here', () => {
		const w = renderWith({ [filePart.fileId]: { present: 12, total: 12, unknown: false, deleted: false } });
		expect(w.find('.msg-availability').exists()).toBe(false);
	});

	it('claims nothing while the manifest is unknown', () => {
		const w = renderWith({ [filePart.fileId]: { present: 0, total: 0, unknown: true, deleted: false } });
		expect(w.find('.msg-availability').exists()).toBe(false);
	});

	it('offers a retry that asks for the file again', async () => {
		const w = renderWith({ [filePart.fileId]: { present: 5, total: 12, unknown: false, deleted: false } });
		await w.find('.msg-availability-btn').trigger('click');
		expect(w.emitted('downloadFile')[0][0]).toMatchObject({ fileId: filePart.fileId });
	});
});

describe('§1.4 video', () => {
	const videoPart = {
		kind: 'video', widthAspect: 4, heightAspect: 3, thumbHashB64: '',
		name: 'clip.mp4', size: 52_428_800, mimeType: 'video/mp4',
		createdAt: 0, fileId: 'f_' + 'e'.repeat(32), encSecretB64: 'AAAA',
	};
	const renderWith = (videos = {}) =>
		mount(ChatWindow, {
			props: {
				title: 'Ирина', myHash: MY, reactions: {},
				messages: [message({ parts: [videoPart], text: '' })],
				videos,
			},
			global: { stubs: { Avatar: true } },
		});

	it('shows a play affordance over the preview frame, sized by the aspect ratio', () => {
		const w = renderWith();
		expect(w.find('.msg-video-triangle').exists()).toBe(true);
		expect(w.find('.msg-video-frame').attributes('style')).toContain('aspect-ratio: 4 / 3');
		expect(w.find('video').exists()).toBe(false);
	});

	it('asks to play on tapping the frame', async () => {
		const w = renderWith();
		await w.find('.msg-video-frame').trigger('click');
		expect(w.emitted('playVideo')[0][0]).toMatchObject({ fileId: videoPart.fileId });
	});

	it('does not re-ask while the source is already opening', async () => {
		const w = renderWith({ [videoPart.fileId]: { status: 'opening' } });
		await w.find('.msg-video-frame').trigger('click');
		expect(w.emitted('playVideo')).toBeFalsy();
		expect(w.find('.msg-video-spinner').exists()).toBe(true);
	});

	it('says it is buffering, with chunk progress when the fallback reports it', () => {
		expect(renderWith({ [videoPart.fileId]: { status: 'opening' } })
			.find('.msg-video-buffering').text()).toBe('buffering');
		expect(renderWith({ [videoPart.fileId]: { status: 'opening', done: 3, total: 13 } })
			.find('.msg-video-buffering').text()).toContain('chunk 3 of 13');
	});

	it('mounts the player once the source is ready', () => {
		const w = renderWith({ [videoPart.fileId]: { status: 'ready', url: '/encrypted-video/abc', streaming: true } });
		const el = w.find('video');
		expect(el.attributes('src')).toBe('/encrypted-video/abc');
		expect(w.find('.msg-video-triangle').exists()).toBe(false);
		// two-layer bar: played over decrypted buffer
		expect(w.find('.msg-video-buffered').exists()).toBe(true);
		expect(w.find('.msg-video-played').exists()).toBe(true);
	});

	// The failure text says "tap to retry", so the frame must actually take
	// the tap in that state.
	it('retries on tapping a failed frame', async () => {
		const w = renderWith({ [videoPart.fileId]: { status: 'error' } });
		expect(w.find('.msg-image-progress._err').text()).toMatch(/tap to retry/);
		await w.find('.msg-video-frame').trigger('click');
		expect(w.emitted('playVideo')[0][0]).toMatchObject({ fileId: videoPart.fileId });
	});
});

describe('carousel walks the whole dialog', () => {
	const img = (tag) => ({
		kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '',
		name: `${tag}.png`, size: 1, mimeType: 'image/png', createdAt: 0,
		fileId: 'f_' + tag.repeat(32).slice(0, 32), encSecretB64: 'AAAA',
	});
	const msgWith = (id, parts, text) => message({
		id, parts, text,
		_raw: { message_id: id, sign_hash: 'dms_' + id, sender_hash: PEER, parent_sign_hash: null },
	});
	const renderTwo = () =>
		mount(ChatWindow, {
			props: {
				title: 'Ирина', myHash: MY, reactions: {},
				messages: [
					msgWith('dmsg_a', [img('a'), { kind: 'text', text: 'первая пара' }], 'первая пара'),
					msgWith('dmsg_b', [{ kind: 'text', text: 'между' }], 'между'),
					msgWith('dmsg_c', [img('c'), img('d')], ''),
				],
			},
			global: { stubs: { Avatar: true } },
		});

	// The user's ask verbatim: pictures from one message AND from different
	// messages, in the order they appear in the chat.
	it('counts every picture in the dialog and steps across messages', async () => {
		const w = renderTwo();
		await w.find('.msg-image').trigger('click'); // the lone picture in msg A
		expect(w.find('.lightbox-count').text()).toBe('1 / 3');

		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('2 / 3'); // first frame of msg C
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('3 / 3');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('1 / 3'); // wrapped to msg A
	});

	it('opens at the tapped frame of a later message, not at the dialog start', async () => {
		const w = renderTwo();
		await w.findAll('.msg-gallery-cell')[1].trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('3 / 3');
	});

	it('switches the caption to the message each frame belongs to', async () => {
		const w = renderTwo();
		await w.find('.msg-image').trigger('click');
		expect(w.find('.lightbox-caption').text()).toBe('первая пара');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-caption').exists()).toBe(false); // msg C has no caption
	});

	it('lists every dialog picture in the strip', async () => {
		const w = renderTwo();
		await w.find('.msg-image').trigger('click');
		expect(w.findAll('.lightbox-thumb')).toHaveLength(3);
	});
});

describe('nested quotes (board card 4)', () => {
	const inner = {
		kind: 'quote', authorHash: PEER, messageId: 'dmsg_root', signHash: 'dms_r',
		snapshot: [{ kind: 'text', text: 'Схему пришли до четверга' }],
	};
	const outer = {
		kind: 'quote', authorHash: MY, messageId: 'dmsg_mid', signHash: 'dms_m',
		snapshot: [inner, { kind: 'text', text: 'Уже в очереди' }],
	};
	const renderReply = () =>
		mount(ChatWindow, {
			props: {
				title: 'Ирина', myHash: MY, reactions: {},
				messages: [message({ parts: [outer, { kind: 'text', text: 'ок, жду' }], text: 'ок, жду' })],
			},
			global: { stubs: { Avatar: true } },
		});

	it('shows the nearest quote and a counter, never the whole thread', () => {
		const w = renderReply();
		expect(w.find('.msg-quote-text').text()).toBe('Уже в очереди');
		expect(w.find('.msg-quote-nested-note').text()).toContain('1 more quote inside');
		expect(w.find('.msg-quote-level').exists()).toBe(false);
	});

	it('expands the chain inside the bubble and collapses back', async () => {
		const w = renderReply();
		await w.find('.msg-quote-nested-note').trigger('click');
		const level = w.find('.msg-quote-level._d2');
		expect(level.exists()).toBe(true);
		expect(level.find('.msg-quote-text').text()).toBe('Схему пришли до четверга');
		expect(level.find('.msg-quote-author').text()).toBe('Ирина');

		const collapse = w.findAll('.msg-quote-nested-note').find((el) => el.text() === 'collapse');
		await collapse.trigger('click');
		expect(w.find('.msg-quote-level').exists()).toBe(false);
	});

	it('caps rendered depth and admits the remainder', async () => {
		const deep = { ...inner };
		const l2 = { kind: 'quote', authorHash: PEER, messageId: 'd2', signHash: 's2', snapshot: [deep, { kind: 'text', text: 'l2' }] };
		const l3 = { kind: 'quote', authorHash: MY, messageId: 'd3', signHash: 's3', snapshot: [l2, { kind: 'text', text: 'l3' }] };
		const l4 = { kind: 'quote', authorHash: PEER, messageId: 'd4', signHash: 's4', snapshot: [l3, { kind: 'text', text: 'l4' }] };
		const w = mount(ChatWindow, {
			props: {
				title: 'Ирина', myHash: MY, reactions: {},
				messages: [message({ parts: [l4, { kind: 'text', text: 'top' }], text: 'top' })],
			},
			global: { stubs: { Avatar: true } },
		});
		await w.find('.msg-quote-nested-note').trigger('click');
		expect(w.findAll('.msg-quote-level')).toHaveLength(2); // depths 2 and 3
		const notes = w.findAll('.msg-quote-nested-note').map((el) => el.text());
		expect(notes.some((t) => t.includes('deeper'))).toBe(true);
	});
});

describe('mobile long press', () => {
	it('opens the context menu after half a second of a steady finger', async () => {
		vi.useFakeTimers();
		try {
			const w = render([message()]);
			await w.find('.message-bubble').trigger('touchstart', { touches: [{ clientX: 50, clientY: 60 }] });
			await vi.advanceTimersByTimeAsync(600);
			expect(w.find('.context-menu').exists()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	// A scroll must never pop a menu.
	it('cancels on movement before the timer fires', async () => {
		vi.useFakeTimers();
		try {
			const w = render([message()]);
			await w.find('.message-bubble').trigger('touchstart', { touches: [{ clientX: 50, clientY: 60 }] });
			await vi.advanceTimersByTimeAsync(200);
			await w.find('.message-bubble').trigger('touchmove');
			await vi.advanceTimersByTimeAsync(600);
			expect(w.find('.context-menu').exists()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
