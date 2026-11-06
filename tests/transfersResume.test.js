// The transfer queue across a reload (pq_files §4.1): a message being composed
// is kept in a sealed record before its first chunk goes out, comes back at
// sign-in with its unfinished files paused, and resumes only from the same
// file picked again. A tab here is a fresh pinia over the same storage and
// locks; closing one ends its rows and holds, as a reload does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const OWNER = 'u_owner';
const uploads = new Map(); // name -> { resolve, opts, meta, onDisk }
let sentMessages;

const { _setPendingUploadsStoreForTests, pendingBatches } = await import('@/lib/data/pendingUploads');
const { uploadDigest } = await import('@/lib/data/uploadReuse');

const uploadAttachment = vi.fn((meta, opts) => new Promise((resolve, reject) => {
	// What the device would know if the page went now: read once the upload has begun.
	uploads.set(meta.name, { resolve, opts, meta, onDisk: pendingBatches(OWNER) });
	if (opts.signal?.aborted) {
		reject(new DOMException('aborted', 'AbortError'));
		return;
	}
	opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
}));
const captureMessageIntent = vi.fn(async (peerHash, parts) => ({ intentId: 'intent_x', payload: { peerHash, parts } }));
const dispatchMessageIntent = vi.fn((intentId, payload, token, onStatus) => {
	sentMessages.push(payload);
	onStatus?.('synced');
	return Promise.resolve();
});

vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ uploadAttachment, captureMessageIntent, dispatchMessageIntent }),
}));

const { useTransfersStore } = await import('@/store/transfers.store');

let records;
let failWrites;
const tabs = [];
beforeEach(() => {
	records = new Map();
	failWrites = false;
	_setPendingUploadsStoreForTests({
		async get(key) { return records.get(key) ?? null; },
		async set(key, value) {
			if (failWrites) throw new DOMException('the origin is out of space', 'QuotaExceededError');
			records.set(key, value);
		},
		async delete(key) { records.delete(key); },
		async keys() { return [...records.keys()]; },
		async clear() { records.clear(); },
	}, () => crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['encrypt', 'decrypt']));
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	uploads.clear();
	sentMessages = [];
	uploadAttachment.mockClear();
	captureMessageIntent.mockClear();
});
afterEach(async () => {
	// A tab left open would go on writing into the next test's storage.
	for (const tab of tabs.splice(0)) await tab.signedIn(null);
	await settle();
	vi.unstubAllGlobals();
});

const fileOf = (name, text) => new File([new TextEncoder().encode(text)], name, { type: 'application/octet-stream' });
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
	for (let i = 0; i < 10; i++) await tick();
};

const openTab = async (owner = OWNER) => {
	setActivePinia(createPinia());
	const tab = useTransfersStore();
	tabs.push(tab);
	await tab.signedIn(owner);
	return tab;
};
const closeTab = async (tab) => {
	await tab.signedIn(null);
	await settle();
};
const finish = (name) => uploads.get(name).resolve({ kind: 'file', name, fileId: uploads.get(name).opts.prepared.fileId });
const rowOf = (tab, name) => tab.items.find((it) => it.name === name);

/** A message with these files, its first file's upload begun. */
const composing = async (files, caption = '') => {
	const tab = await openTab();
	await tab.enqueueBatch('u_peer', files, caption);
	await vi.waitFor(() => expect(uploads.has(files[0].name)).toBe(true));
	return tab;
};

describe('the transfer queue across a reload', () => {
	it('writes the record, its key sealed, before the first chunk goes out', async () => {
		const contract = fileOf('contract.pdf', 'the signed contract');
		await composing([contract], 'see attached');
		const { opts, meta, onDisk } = uploads.get('contract.pdf');

		const digest = await uploadDigest(new Uint8Array(await contract.arrayBuffer()));
		expect(meta.digest).toBe(digest);
		const [record] = await onDisk;
		expect(record).toMatchObject({ peerHash: 'u_peer', caption: 'see attached', parts: [] });
		expect(record.files).toEqual([expect.objectContaining({
			name: 'contract.pdf', size: contract.size, chunkCount: 1, digest, ...opts.prepared,
		})]);

		const stored = [...records].join('\n');
		expect(stored).not.toContain(opts.prepared.encSecretB64);
		expect(stored).not.toContain('contract.pdf');
	});

	it('sends no chunk of a file whose record could not be written', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		failWrites = true;
		const tab = await openTab();
		await tab.enqueueBatch('u_peer', [fileOf('a.bin', 'first file')]);
		await vi.waitFor(() => expect(tab.items[0].status).toBe('error'));
		expect(uploadAttachment).not.toHaveBeenCalled();

		failWrites = false;
		tab.start(tab.items[0].id);
		await vi.waitFor(() => expect(uploads.has('a.bin')).toBe(true));
		const [record] = await uploads.get('a.bin').onDisk;
		expect(record.files[0].digest).toBe(tab.items[0].digest);
		errorSpy.mockRestore();
	});

	it('keeps no record of a message this tab could not lock', async () => {
		vi.stubGlobal('navigator', { locks: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) } });
		await composing([fileOf('a.bin', 'first file')]);
		expect(await uploads.get('a.bin').onDisk).toEqual([]);
		expect(records.size).toBe(0);
	});

	it('brings the message back paused, and the same file resumes it under the same key', async () => {
		const tab = await composing([fileOf('a.bin', 'first file')], 'caption');
		const { prepared } = uploads.get('a.bin').opts;
		await closeTab(tab);

		const next = await openTab();
		expect(next.items).toEqual([expect.objectContaining({ name: 'a.bin', status: 'paused', blob: null, prepared })]);
		const lock = `buckitup:transfers:${next.items[0].batchId}`;
		expect(navigator.locks.held(lock)).toBe(true);
		next.start(next.items[0].id);
		await settle();
		expect(next.items[0].status).toBe('paused');

		uploadAttachment.mockClear();
		expect(await next.repick(next.items[0].id, fileOf('a.bin', 'first file'))).toBe(true);
		await vi.waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
		expect(uploadAttachment.mock.calls[0][1]).toMatchObject({ prepared, resuming: true });

		finish('a.bin');
		await vi.waitFor(() => expect(sentMessages).toHaveLength(1));
		expect(sentMessages[0]).toMatchObject({ peerHash: 'u_peer', parts: [{ name: 'a.bin' }, { kind: 'text', text: 'caption' }] });
		await vi.waitFor(() => expect(records.size).toBe(0));
		expect(navigator.locks.held(lock)).toBe(false);
	});

	it('refuses another file, and sends nothing', async () => {
		await closeTab(await composing([fileOf('a.bin', 'first file')])); // 10 bytes
		const tab = await openTab();
		const id = tab.items[0].id;
		uploadAttachment.mockClear();

		expect(await tab.repick(id, fileOf('a.bin', 'other file'))).toBe(false); // same size, other bytes
		expect(await tab.repick(id, fileOf('a.bin', 'a longer file'))).toBe(false);
		await settle();
		expect(uploadAttachment).not.toHaveBeenCalled();
		expect(tab.items[0]).toMatchObject({ status: 'paused', blob: null });
	});

	it('matches a file that sent nothing yet by its size and name', async () => {
		await closeTab(await composing([fileOf('a.bin', 'first file'), fileOf('b.bin', 'second')]));
		const tab = await openTab();
		const b = rowOf(tab, 'b.bin');
		expect(b.digest).toBeNull();
		expect(await tab.repick(b.id, fileOf('c.bin', 'second'))).toBe(false);
		expect(await tab.repick(b.id, fileOf('b.bin', 'SECOND'))).toBe(true);
	});

	it('sends the parts that landed before the reload with the rest', async () => {
		const tab = await composing([fileOf('a.bin', 'first file'), fileOf('b.bin', 'second')], 'both');
		finish('a.bin');
		await vi.waitFor(() => expect(uploads.has('b.bin')).toBe(true));
		const [record] = await uploads.get('b.bin').onDisk;
		expect(record.parts).toEqual([{ order: 0, part: expect.objectContaining({ name: 'a.bin' }) }]);
		expect(record.files.map((f) => f.name)).toEqual(['b.bin']);
		await closeTab(tab);

		const next = await openTab();
		expect(next.items.map((it) => it.name)).toEqual(['b.bin']);
		uploadAttachment.mockClear();
		await next.repick(next.items[0].id, fileOf('b.bin', 'second'));
		await vi.waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
		finish('b.bin');
		await vi.waitFor(() => expect(sentMessages).toHaveLength(1));
		expect(sentMessages[0].parts.map((p) => p.name ?? p.text)).toEqual(['a.bin', 'b.bin', 'both']);
	});

	it('keeps a file cancelled after it landed out of the message', async () => {
		const tab = await composing([fileOf('a.bin', 'first file'), fileOf('b.bin', 'second')]);
		finish('a.bin');
		await vi.waitFor(() => expect(uploads.has('b.bin')).toBe(true));
		await tab.cancel(rowOf(tab, 'a.bin').id);
		await closeTab(tab);

		const next = await openTab();
		await next.repick(next.items[0].id, fileOf('b.bin', 'second'));
		await vi.waitFor(() => expect(uploads.get('b.bin').opts.resuming).toBe(true));
		finish('b.bin');
		await vi.waitFor(() => expect(sentMessages).toHaveLength(1));
		expect(sentMessages[0].parts.map((p) => p.name)).toEqual(['b.bin']);
	});

	it('cancelling the paused file ends the record', async () => {
		await closeTab(await composing([fileOf('a.bin', 'first file')]));
		const tab = await openTab();
		await tab.cancel(tab.items[0].id);
		await vi.waitFor(() => expect(records.size).toBe(0));
		expect(sentMessages).toEqual([]);
	});

	it('ends the record when the message cannot be stored for sending', async () => {
		captureMessageIntent.mockRejectedValueOnce(new Error('the intent store is full'));
		await composing([fileOf('a.bin', 'first file')]);
		finish('a.bin');
		await vi.waitFor(() => expect(captureMessageIntent).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(records.size).toBe(0));
	});

	it('shows only the signed-in account\'s uploads, and keeps the other\'s record for it', async () => {
		const tab = await composing([fileOf('a.bin', 'first file')]);
		await tab.signedIn('u_other');
		await settle();
		expect(tab.items).toEqual([]);
		expect(records.size).toBe(1);
		await tab.signedIn(OWNER);
		expect(tab.items).toEqual([expect.objectContaining({ name: 'a.bin', status: 'paused', blob: null })]);
	});

	it('does not bring back a message another tab is still sending', async () => {
		const sending = await composing([fileOf('a.bin', 'first file')]);
		await settle();
		const other = await openTab();
		expect(other.items).toEqual([]);
		await closeTab(sending);
		const later = await openTab();
		expect(later.items.map((it) => it.name)).toEqual(['a.bin']);
	});
});
