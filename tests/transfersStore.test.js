// The transfer queue's contract (board §2.1, screen 10): rows are
// independent, pause is honest resume, order is the schedule, and a batch
// becomes ONE message from whatever rows survive.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const uploads = new Map(); // name -> { resolve, reject, signal, opts }
let sentMessages;

const uploadAttachment = vi.fn((meta, opts) => new Promise((resolve, reject) => {
	uploads.set(meta.name, { resolve, reject, signal: opts.signal, opts, meta });
	opts.signal?.addEventListener('abort', () => {
		reject(new DOMException('aborted', 'AbortError'));
	});
}));

const sendMessage = vi.fn((peerHash, parts, onStatus) => {
	sentMessages.push({ peerHash, parts });
	onStatus?.('synced');
	return 'dmsg_x';
});

vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ uploadAttachment, sendMessage }),
}));

const { useTransfersStore } = await import('@/store/transfers.store');

const file = (name, size = 8 * 1024 * 1024) =>
	new File([new Uint8Array(10)], name, { type: 'application/octet-stream' });
// File.size from content would be 10; the store reads .size for captions and
// chunk totals — patch it to the intended value.
const bigFile = (name, size) => {
	const f = file(name);
	Object.defineProperty(f, 'size', { value: size });
	return f;
};

const finish = (name) => {
	const u = uploads.get(name);
	u.resolve({ kind: 'file', name, fileId: 'f_' + name, size: 1, mimeType: 'x', createdAt: 0, encSecretB64: 'x' });
	uploads.delete(name);
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('transfer queue', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		uploads.clear();
		sentMessages = [];
		uploadAttachment.mockClear();
		sendMessage.mockClear();
	});

	it('drains sequentially: one active row, the rest wait', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a'), file('b'), file('c')], '');
		await tick();
		expect(store.items.map((i) => i.status)).toEqual(['active', 'waiting', 'waiting']);
		finish('a');
		await tick(); await tick();
		expect(store.items.find((i) => i.name === 'b').status).toBe('active');
	});

	// The user's report verbatim: cancelling one file killed them all.
	it('cancelling one row keeps the rest and sends the message without it', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a'), file('b')], 'подпись');
		await tick();

		await store.cancel(store.items.find((i) => i.name === 'a').id);
		await tick();
		finish('b');
		await tick(); await tick();

		expect(sentMessages).toHaveLength(1);
		const names = sentMessages[0].parts.filter((p) => p.kind === 'file').map((p) => p.name);
		expect(names).toEqual(['b']);
		expect(sentMessages[0].parts.at(-1)).toEqual({ kind: 'text', text: 'подпись' });
	});

	it('cancelling every row sends nothing', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a'), file('b')], '');
		await tick();
		for (const it of [...store.items]) await store.cancel(it.id);
		await tick();
		expect(sentMessages).toHaveLength(0);
		expect(store.items).toHaveLength(0);
	});

	// §2.2: pause must not reset the upload — resume re-enters with the SAME
	// file_id/enc_secret and the transport re-sends only what is missing.
	it('pause aborts the active upload; resume re-enters with the same prepared pair', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a')], '');
		await tick();
		const firstCall = uploadAttachment.mock.calls[0][1];
		const preparedBefore = store.items[0].prepared;
		// report some progress, then pause mid-flight
		firstCall.onProgress({ done: 3, total: 8 });
		store.pause(store.items[0].id);
		await tick();
		expect(store.items[0].status).toBe('paused');

		store.start(store.items[0].id);
		await tick();
		const secondCall = uploadAttachment.mock.calls[1][1];
		expect(secondCall.prepared).toBe(preparedBefore);
		expect(secondCall.resuming).toBe(true);
	});

	it('a failed row waits for Start instead of retrying itself', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a')], '');
		await tick();
		uploads.get('a').reject(new Error('device unreachable'));
		uploads.delete('a');
		await tick();
		expect(store.items[0].status).toBe('error');

		store.start(store.items[0].id);
		await tick();
		expect(store.items[0].status).toBe('active');
	});

	// The order IS the schedule: dragging a row up makes it next.
	it('reordering changes which waiting row runs next', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [file('a'), file('b'), file('c')], '');
		await tick();
		store.reorder(2, 1); // move c ahead of b
		finish('a');
		await tick(); await tick();
		expect(store.items.find((i) => i.status === 'active').name).toBe('c');
	});

	it('sent rows leave the list after 3 seconds', async () => {
		vi.useFakeTimers();
		try {
			const store = useTransfersStore();
			const p = store.enqueueBatch('u_peer', [file('a')], '');
			await vi.advanceTimersByTimeAsync(0);
			await p;
			await vi.advanceTimersByTimeAsync(0);
			finish('a');
			await vi.advanceTimersByTimeAsync(0);
			expect(store.items[0].status).toBe('done');
			await vi.advanceTimersByTimeAsync(3100);
			expect(store.items).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('aggregates chunks for the header', async () => {
		const store = useTransfersStore();
		await store.enqueueBatch('u_peer', [bigFile('a', 8 * 1024 * 1024), bigFile('b', 4 * 1024 * 1024)], '');
		await tick();
		uploadAttachment.mock.calls[0][1].onProgress({ done: 1, total: 2 });
		expect(store.stats.totalChunks).toBe(3);
		expect(store.stats.doneChunks).toBe(1);
		expect(store.stats.percent).toBe(33);
	});
});
