// The transfer queue (design board §2.1, screen 10).
//
// A first-class store, not page state: transfers outlive the dialog view
// that started them, every row has its own lifecycle, and the row states are
// exactly the board's five — waiting, active, paused, broken, sent.
//
// One worker drains the queue sequentially: the device's chunk lane is
// single-writer and answers concurrency with 429s, so parallel uploads only
// add retry traffic. Order is the list order, and the list is reorderable —
// the worker always takes the first waiting row.
//
// Pause is honest, not cosmetic: it aborts the running upload, and resume
// re-enters with the same file_id + enc_secret, so the transport's resume
// path re-sends only the chunks the device does not hold (§2.2 — "Пауза не
// сбрасывает загрузку").
//
// A batch is the message being composed (screen 02): its files become parts
// of ONE composed message, sent when the last live row lands. Cancelling a
// row removes that attachment and the rest still send; cancelling everything
// sends nothing.

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { prepareUpload } from '@/lib/data/fileTransfer';
import { CHUNK_SIZE, chunkCountOf } from '@/lib/pq/fileCrypto';
import { useDialogsStore } from '@/store/dialogs.store';

let seq = 0;

export const useTransfersStore = defineStore('transfers', () => {
	const items = ref([]);   // ordered; the worker takes the first 'waiting'
	const batches = ref(new Map()); // batchId -> { peerHash, caption, status }
	const collapsed = ref(false);

	const aborts = new Map();      // itemId -> AbortController
	const pauseRequested = new Set();

	const patch = (id, changes) => {
		items.value = items.value.map((it) => (it.id === id ? { ...it, ...changes } : it));
	};
	const byId = (id) => items.value.find((it) => it.id === id);

	// ---------- queueing ----------

	const enqueueBatch = async (peerHash, files, caption = '') => {
		const batchId = `batch_${++seq}`;
		batches.value = new Map(batches.value).set(batchId, { peerHash, caption, status: 'open' });

		const newItems = [];
		for (const file of files) {
			newItems.push({
				id: `tr_${++seq}`,
				batchId,
				name: file.name,
				size: file.size,
				mimeType: file.type,
				createdAt: Math.floor((file.lastModified || Date.now()) / 1000),
				blob: file,
				status: 'waiting',
				done: 0,
				total: chunkCountOf(file.size),
				speed: 0,
				// Minted before the first PUT and kept for the row's whole
				// life (§4.1): pause/resume and retry must re-enter with the
				// same pair or the re-sent chunks join nothing.
				prepared: prepareUpload((await import('uuid')).v7()),
				part: null,
			});
		}
		items.value = [...items.value, ...newItems];
		drain();
		return batchId;
	};

	// ---------- the worker ----------

	let running = false;

	const drain = async () => {
		if (running) return;
		running = true;
		try {
			for (;;) {
				const next = items.value.find((it) => it.status === 'waiting');
				if (!next) break;
				await runOne(next.id);
			}
		} finally {
			running = false;
		}
	};

	const runOne = async (id) => {
		const item = byId(id);
		if (!item || item.status !== 'waiting') return;

		const dialogs = useDialogsStore();
		const ctrl = new AbortController();
		aborts.set(id, ctrl);
		const startedAt = Date.now();
		patch(id, { status: 'active', speed: 0 });

		try {
			const bytes = new Uint8Array(await item.blob.arrayBuffer());
			const part = await dialogs.uploadAttachment({
				name: item.name,
				mimeType: item.mimeType,
				bytes,
				blob: item.blob,
				createdAt: item.createdAt,
			}, {
				prepared: item.prepared,
				// Anything may already be on the device from before a pause.
				resuming: item.done > 0,
				signal: ctrl.signal,
				onProgress: (p) => {
					const elapsed = (Date.now() - startedAt) / 1000;
					patch(id, {
						done: p.done,
						total: p.total,
						speed: elapsed > 0.5 ? (p.done * CHUNK_SIZE) / elapsed : 0,
					});
				},
			});
			patch(id, { status: 'done', part, speed: 0 });
			scheduleRemoval(id);
			await maybeSendBatch(item.batchId);
		} catch (e) {
			if (pauseRequested.delete(id)) {
				patch(id, { status: 'paused', speed: 0 });
			} else if (ctrl.signal.aborted) {
				removeItem(id); // cancelled — the batch decision runs in cancel()
			} else {
				console.error('[transfers]', item.name, e);
				patch(id, { status: 'error', speed: 0 });
			}
		} finally {
			aborts.delete(id);
		}
	};

	// ---------- batch completion ----------

	const liveOf = (batchId) =>
		items.value.filter((it) => it.batchId === batchId && it.status !== 'done');

	const maybeSendBatch = async (batchId) => {
		const batch = batches.value.get(batchId);
		if (!batch || batch.status !== 'open') return;
		if (liveOf(batchId).length > 0) return;

		const parts = items.value
			.filter((it) => it.batchId === batchId && it.part)
			.map((it) => it.part);
		if (!parts.length) {
			batches.value = new Map(batches.value).set(batchId, { ...batch, status: 'empty' });
			return;
		}
		if (batch.caption.trim()) parts.push({ kind: 'text', text: batch.caption.trim() });

		batches.value = new Map(batches.value).set(batchId, { ...batch, status: 'sending' });
		const dialogs = useDialogsStore();
		await dialogs.sendMessage(batch.peerHash, parts, (status) => {
			if (status === 'synced' || status === 'error') {
				batches.value = new Map(batches.value).set(batchId, { ...batch, status });
			}
		});
	};

	// ---------- row actions (board: Старт / Пауза / Продолжить / ✕) ----------

	const pause = (id) => {
		const item = byId(id);
		if (!item) return;
		if (item.status === 'active') {
			pauseRequested.add(id);
			aborts.get(id)?.abort();
		} else if (item.status === 'waiting') {
			patch(id, { status: 'paused' });
		}
	};

	const start = (id) => {
		const item = byId(id);
		if (!item || (item.status !== 'paused' && item.status !== 'error')) return;
		patch(id, { status: 'waiting' });
		drain();
	};

	const startAll = () => {
		items.value = items.value.map((it) =>
			it.status === 'paused' || it.status === 'error' ? { ...it, status: 'waiting' } : it);
		drain();
	};

	/** Cancels ONE row; the rest of its batch still becomes the message. */
	const cancel = async (id) => {
		const item = byId(id);
		if (!item) return;
		if (item.status === 'active') {
			aborts.get(id)?.abort(); // runOne removes it and we finish the batch below
		} else {
			removeItem(id);
		}
		await maybeSendBatch(item.batchId);
	};

	const cancelAll = async () => {
		const batchIds = new Set(items.value.map((it) => it.batchId));
		for (const it of [...items.value]) {
			if (it.status === 'active') aborts.get(it.id)?.abort();
			else if (it.status !== 'done') removeItem(it.id);
		}
		for (const b of batchIds) await maybeSendBatch(b);
	};

	const removeItem = (id) => {
		items.value = items.value.filter((it) => it.id !== id);
	};

	/** Sent rows leave on their own after 3s (§2.1). */
	const scheduleRemoval = (id) => {
		setTimeout(() => {
			if (byId(id)?.status === 'done') removeItem(id);
		}, 3000);
	};

	// ---------- ordering (the drag handle) ----------

	/**
	 * Moves a row to a new position. The order IS the schedule: the worker
	 * always takes the first waiting row, so dragging a row up makes it next.
	 */
	const reorder = (fromIndex, toIndex) => {
		const list = [...items.value];
		if (fromIndex < 0 || fromIndex >= list.length) return;
		const [moved] = list.splice(fromIndex, 1);
		list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, moved);
		items.value = list;
	};

	// ---------- header aggregates (screen 10) ----------

	const stats = computed(() => {
		const all = items.value;
		const doneChunks = all.reduce((n, it) => n + it.done, 0);
		const totalChunks = all.reduce((n, it) => n + it.total, 0);
		return {
			count: all.length,
			active: all.filter((it) => it.status === 'active').length,
			waiting: all.filter((it) => it.status === 'waiting').length,
			percent: totalChunks ? Math.round((doneChunks / totalChunks) * 100) : 0,
			doneChunks,
			totalChunks,
		};
	});

	const toggleCollapsed = () => { collapsed.value = !collapsed.value; };

	return {
		items, stats, collapsed,
		enqueueBatch, pause, start, startAll, cancel, cancelAll, reorder, toggleCollapsed,
	};
});
