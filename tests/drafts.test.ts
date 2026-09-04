// Draft semantics: an unsent input is data, not UI state. It must round-trip,
// an empty draft must not leave a record behind, and an unreadable record
// (locked vault, another account's key) must read as "no draft", never throw
// into the input path.
import { describe, it, expect, beforeEach } from 'vitest';
import { _setStoreForTests } from '@/lib/data/localStore';
import { loadDraft, saveDraft, clearDraft } from '@/lib/data/drafts';

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);

let mem: Map<string, string>;
let failReads = false;

beforeEach(() => {
	mem = new Map();
	failReads = false;
	_setStoreForTests({
		async get(k) {
			if (failReads) throw new Error('locked vault');
			return mem.get(k) ?? null;
		},
		async set(k, v) { mem.set(k, v); },
		async delete(k) { mem.delete(k); },
		async keys() { return [...mem.keys()]; },
		async clear() { mem.clear(); },
	});
});

describe('drafts', () => {
	it('round-trips text and reply context per dialog', async () => {
		const replyTo = { messageId: 'dmsg_1', previewText: 'цитата' };
		await saveDraft(MY, PEER, { text: 'недописанное…', replyTo, savedAt: 1 });
		expect(await loadDraft(MY, PEER)).toEqual({ text: 'недописанное…', replyTo, savedAt: 1 });
		expect(await loadDraft(MY, 'u_' + 'c'.repeat(128))).toBe(null);
	});

	it('an emptied draft deletes the record instead of storing ciphertext of nothing', async () => {
		await saveDraft(MY, PEER, { text: 'что-то', replyTo: null, savedAt: 1 });
		expect(mem.size).toBe(1);
		await saveDraft(MY, PEER, { text: '   ', replyTo: null, savedAt: 2 });
		expect(mem.size).toBe(0);
	});

	it('a bare reply context is still a draft worth keeping', async () => {
		await saveDraft(MY, PEER, { text: '', replyTo: { messageId: 'dmsg_1' }, savedAt: 1 });
		expect((await loadDraft(MY, PEER))?.replyTo).toEqual({ messageId: 'dmsg_1' });
	});

	it('an unreadable record reads as no-draft, and stays stored', async () => {
		await saveDraft(MY, PEER, { text: 'сохранено', replyTo: null, savedAt: 1 });
		failReads = true;
		expect(await loadDraft(MY, PEER)).toBe(null);
		failReads = false;
		expect((await loadDraft(MY, PEER))?.text).toBe('сохранено'); // not dropped
	});

	it('clearDraft removes the record; missing identity is a no-op', async () => {
		await saveDraft(MY, PEER, { text: 'x', replyTo: null, savedAt: 1 });
		await clearDraft(MY, PEER);
		expect(mem.size).toBe(0);
		await saveDraft('', PEER, { text: 'x', replyTo: null, savedAt: 1 });
		expect(mem.size).toBe(0);
	});
});
