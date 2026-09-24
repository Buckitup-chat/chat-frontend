// The alert decision itself: does the dialog show something other than what
// the checkpoint fixed, and does the pointer survive a round trip.
import { describe, it, expect, beforeEach } from 'vitest';
import { _setStoreForTests } from '@/lib/data/localStore';
import { loadPointer, savePointer, rawViewState, viewMoved, pointerDialogs, rememberPointerDialog, type AlertRow } from '@/lib/data/checkpointAlerts';
import { buildViewTree, CHECKPOINT_SEMANTICS } from '@/lib/pq/checkpoint';

const M1 = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const M2 = 'dmsg_0192aabb-0000-7000-8000-000000000002';
const sh = (n: number) => 'dms_' + String(n).repeat(128);

const rows: AlertRow[] = [
	{ message_id: M1, sign_hash: sh(1), deleted_flag: false },
	{ message_id: M2, sign_hash: sh(2), deleted_flag: false },
];
const rootOf = (r: AlertRow[]) => buildViewTree(rawViewState(r)).root;

describe('alert decision', () => {
	it('an unchanged dialog does not alert', () => {
		expect(viewMoved(rows, rootOf(rows))).toBe(false);
	});

	it('a new message, an edit and a tombstone each alert', () => {
		const root = rootOf(rows);
		const added = [...rows, { message_id: 'dmsg_0192aadd-0000-7000-8000-000000000003', sign_hash: sh(3), deleted_flag: false }];
		const edited = [rows[0], { ...rows[1], sign_hash: sh(4) }];
		const deleted = [rows[0], { ...rows[1], deleted_flag: true }];
		expect(viewMoved(added, root)).toBe(true);
		expect(viewMoved(edited, root)).toBe(true);
		expect(viewMoved(deleted, root)).toBe(true);
	});

	// SQLite has no boolean; a persisted tombstone comes back as 0/1 and must
	// not read as a change on its own.
	it('a 0/1 deleted_flag from persistence matches the boolean form', () => {
		const asInts = rows.map((r) => ({ ...r, deleted_flag: 0 }));
		expect(viewMoved(asInts, rootOf(rows))).toBe(false);
		const tomb = [rows[0], { ...rows[1], deleted_flag: 1 }];
		const tombBool = [rows[0], { ...rows[1], deleted_flag: true }];
		expect(rootOf(tomb)).toBe(rootOf(tombBool));
	});

	it('row order does not affect the decision', () => {
		expect(viewMoved([...rows].reverse(), rootOf(rows))).toBe(false);
	});
});

describe('pointer storage', () => {
	let mem: Map<string, string>;
	beforeEach(() => {
		mem = new Map();
		_setStoreForTests({
			async get(k) { return mem.get(k) ?? null; },
			async set(k, v) { mem.set(k, v); },
			async delete(k) { mem.delete(k); },
			async keys() { return [...mem.keys()]; },
			async clear() { mem.clear(); },
		});
	});

	const ME = 'u_' + 'a'.repeat(128);
	const DIALOG = 'di_' + 'b'.repeat(128);

	it('round-trips, and an unknown dialog reads as nothing scanned', async () => {
		expect(await loadPointer(ME, DIALOG)).toEqual({ sem: CHECKPOINT_SEMANTICS, checkpoint: null, scannedTo: 0 });
		const pointer = {
			checkpoint: { messageId: M1, viewRoot: rootOf(rows), frontierRoot: 'dfr_x', createdAt: 1788470000 },
			scannedTo: 1788470000123,
		};
		await savePointer(ME, DIALOG, pointer);
		expect(await loadPointer(ME, DIALOG)).toEqual({ ...pointer, sem: CHECKPOINT_SEMANTICS });
	});

	// Roots from other checkpoint semantics are incomparable with freshly
	// derived ones; a stale pointer must read as EMPTY (rescan), not as a
	// baseline that lights an unquenchable dot.
	it('a pointer saved under other semantics reads as nothing known', async () => {
		mem.set(`cpptr|${ME}|${DIALOG}`, JSON.stringify({
			sem: '2|dialog-state-v1|dialog-view-tree-v2', // an older build's stamp
			checkpoint: { messageId: M1, viewRoot: 'dvr_old', frontierRoot: 'dfr_old', createdAt: 1 },
			scannedTo: 999,
		}));
		// raw write above bypasses savePointer's stamping — emulate exactly
		// what an older build left behind
		_setStoreForTests({
			async get(k) { const v = mem.get(k); return v ? JSON.parse(v as string) : null; },
			async set(k, v) { mem.set(k, JSON.stringify(v)); },
			async delete(k) { mem.delete(k); },
			async keys() { return [...mem.keys()]; },
			async clear() { mem.clear(); },
		});
		expect(await loadPointer(ME, DIALOG)).toEqual({ sem: CHECKPOINT_SEMANTICS, checkpoint: null, scannedTo: 0 });
	});

	// Two dialogs indexed concurrently: the second read-modify-write must not
	// overwrite the first (the sweep and a fresh signing interleave through
	// await points on the same index array).
	it('concurrent index registrations both survive', async () => {
		const slow = new Map<string, string>();
		_setStoreForTests({
			async get(k) { await new Promise((r) => setTimeout(r, 1)); return slow.get(k) ?? null; },
			async set(k, v) { await new Promise((r) => setTimeout(r, 1)); slow.set(k, v); },
			async delete(k) { slow.delete(k); },
			async keys() { return [...slow.keys()]; },
			async clear() { slow.clear(); },
		});
		const D2 = 'di_' + 'e'.repeat(128);
		await Promise.all([
			rememberPointerDialog(ME, DIALOG),
			rememberPointerDialog(ME, D2),
		]);
		expect(await pointerDialogs(ME)).toEqual(new Set([DIALOG, D2]));
	});

	// An unreadable index is "unknown", not "empty": the sweep retries next
	// tick instead of silently skipping every dialog for the session.
	it('an unreadable index reads as unknown, an absent one as empty', async () => {
		expect(await pointerDialogs(ME)).toEqual(new Set());
		_setStoreForTests({
			async get() { throw new Error('locked vault'); },
			async set() {}, async delete() {}, async keys() { return []; }, async clear() {},
		});
		expect(await pointerDialogs(ME)).toBe(null);
	});

	it('is scoped per account and per dialog', async () => {
		await savePointer(ME, DIALOG, { checkpoint: null, scannedTo: 42 });
		expect((await loadPointer('u_' + 'c'.repeat(128), DIALOG)).scannedTo).toBe(0);
		expect((await loadPointer(ME, 'di_' + 'd'.repeat(128))).scannedTo).toBe(0);
	});

	it('an unreadable record reads as nothing known instead of throwing', async () => {
		_setStoreForTests({
			async get() { throw new Error('locked vault'); },
			async set() {}, async delete() {}, async keys() { return []; }, async clear() {},
		});
		expect(await loadPointer(ME, DIALOG)).toEqual({ sem: CHECKPOINT_SEMANTICS, checkpoint: null, scannedTo: 0 });
	});

	// One unreadable READ must not become a write that replaces the whole
	// index with a single dialog — the sweep is gated on this record, and
	// round 2's own fix taught the reader the difference; the writer has to
	// keep it.
	it('a failed index read never clobbers the stored index', async () => {
		const slow = new Map<string, string>();
		let failNextGet = false;
		_setStoreForTests({
			async get(k) {
				if (failNextGet) { failNextGet = false; throw new Error('locked vault'); }
				return slow.get(k) ?? null;
			},
			async set(k, v) { slow.set(k, v); },
			async delete(k) { slow.delete(k); },
			async keys() { return [...slow.keys()]; },
			async clear() { slow.clear(); },
		});
		const D2 = 'di_' + 'e'.repeat(128);
		await rememberPointerDialog(ME, DIALOG);
		failNextGet = true;
		await rememberPointerDialog(ME, D2); // read fails → write skipped
		expect(await pointerDialogs(ME)).toEqual(new Set([DIALOG]));
		await rememberPointerDialog(ME, D2); // next attempt merges honestly
		expect(await pointerDialogs(ME)).toEqual(new Set([DIALOG, D2]));
	});

	// The raw view path runs on unadmitted replicas: a hostile message_id
	// must be dropped, not become a trie key that throws in the hasher.
	it('rawViewState drops out-of-grammar ids instead of throwing later', () => {
		const hostile = [...rows, { message_id: 'dmsg_ключ', sign_hash: sh(6), deleted_flag: false }];
		expect(() => viewMoved(hostile, rootOf(rows))).not.toThrow();
		expect(viewMoved(hostile, rootOf(rows))).toBe(false); // filtered out
	});
});

describe('what counts as a change', () => {
	const CARRIER = 'dmsg_0192aacc-0000-7000-8000-00000000000c';

	// The checkpoint travels as a message, so signing one adds a row that did
	// not exist when the root was computed. Counting it would make every
	// checkpoint immediately report its own arrival.
	it('the message carrying the checkpoint is not a change', () => {
		const root = buildViewTree(rawViewState(rows)).root;
		const withCarrier = [...rows, { message_id: CARRIER, sign_hash: sh(9), deleted_flag: false }];
		expect(viewMoved(withCarrier, root)).toBe(true); // without the exclusion
		expect(viewMoved(withCarrier, root, CARRIER)).toBe(false); // with it
	});

	// The pointer is about the dialog, not about the other side: what this
	// account writes after confirming a state is a change like any other.
	it('a message this account sent afterwards is a change', () => {
		const root = buildViewTree(rawViewState(rows)).root;
		const mine = [...rows, { message_id: 'dmsg_0192aaee-0000-7000-8000-000000000005', sign_hash: sh(5), deleted_flag: false }];
		expect(viewMoved(mine, root, CARRIER)).toBe(true);
	});

	it('an edit of a message counts whoever made it', () => {
		const root = buildViewTree(rawViewState(rows)).root;
		const edited = [rows[0], { ...rows[1], sign_hash: sh(7) }];
		expect(viewMoved(edited, root, CARRIER)).toBe(true);
	});
});
