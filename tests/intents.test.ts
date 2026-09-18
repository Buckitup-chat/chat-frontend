import { describe, it, expect, beforeEach } from 'vitest';
import {
	enqueueIntent, getIntent, updateIntent, resolveIntent, intentsOf,
	_setIntentStorageForTests, _clearIntentsForTests,
} from '@/lib/data/intents';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

let storage: ReturnType<typeof makeStorage>;

beforeEach(async () => {
	storage = makeStorage();
	_setIntentStorageForTests(storage);
	await _clearIntentsForTests();
});

describe('durable intent, before signing', () => {
	it('persists the exact captured payload — reload does not refresh it to something newer', async () => {
		const captured = { refs: ['tail-a', 'tail-b'], text: 'first draft' };
		const id = await enqueueIntent(captured, A, 'dialog_messages');
		expect(id).toBeTruthy();

		_setIntentStorageForTests({ ...storage });

		const reloaded = await getIntent(id!);
		expect(reloaded?.intent).toEqual(captured);
		expect(reloaded?.userHash).toBe(A);
		expect(reloaded?.relation).toBe('dialog_messages');
	});

	it('updateIntent coalesces in place — one durable record, not a growing history', async () => {
		const id = await enqueueIntent({ text: 'v1' }, A, 'dialog_messages');
		await updateIntent(id!, { text: 'v2' });
		await updateIntent(id!, { text: 'v3, final before send' });

		expect((await intentsOf(A)).entries.length).toBe(1);
		expect((await getIntent(id!))?.intent).toEqual({ text: 'v3, final before send' });
	});

	it('resolveIntent replaces the intent with a durable, positive terminal marker — not a delete', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await resolveIntent(id!, { outcome: 'durably-dispatched', ref: 'outbox-1' });

		const marker = await getIntent(id!);
		expect(marker).not.toBeNull();
		expect(marker!.intent).toMatchObject({ resolved: true, outcome: 'durably-dispatched', ref: 'outbox-1' });
		expect((await intentsOf(A)).entries).toEqual([]);
	});

	it('resolveIntent is idempotent — resolving an already-resolved id again does not throw or lose the marker', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await resolveIntent(id!, { outcome: 'durably-dispatched', ref: 'outbox-1' });
		await resolveIntent(id!, { outcome: 'durably-dispatched', ref: 'outbox-1' });

		expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true });
	});

	it('resolveIntent on an unknown id is a safe no-op (already gone, nothing to mark)', async () => {
		await expect(resolveIntent('never-existed', { outcome: 'durably-dispatched', ref: 'outbox-1' })).resolves.toBe(true);
	});

	it('resolveIntent refuses to mark "durably-dispatched" with no outbox reference', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await expect(resolveIntent(id!, { outcome: 'durably-dispatched' })).resolves.toBe(false);
		expect((await getIntent(id!))?.intent).toEqual({ text: 'x' });
	});

	it('updateIntent on an already-resolved id refuses (returns false), never resurrecting a stale payload', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await resolveIntent(id!, { outcome: 'durably-dispatched', ref: 'outbox-1' });

		const ok = await updateIntent(id!, { text: 'too late' });

		expect(ok).toBe(false);
		expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true });
	});

	it('is durable across reload before any signing happens — the point of §3.1', async () => {
		const id = await enqueueIntent({ refs: ['t1'], text: 'unsent' }, A, 'dialog_messages');
		_setIntentStorageForTests({ ...storage });
		const recovered = await getIntent(id!);
		expect(recovered).not.toBeNull();
		expect(recovered!.intent).toEqual({ refs: ['t1'], text: 'unsent' });
	});
});

describe('getIntent distinguishes absence from failure (§2)', () => {
	it('propagates a storage read failure — never silently reads it as "not found"', async () => {
		_setIntentStorageForTests({
			async get() { throw new Error('indexeddb blocked'); },
			async set() { throw new Error('indexeddb blocked'); },
			async delete() {},
			async keys() { throw new Error('indexeddb blocked'); },
			async clear() {},
		});

		await expect(getIntent('some-id')).rejects.toThrow(/indexeddb blocked/i);
	});

	it('propagates a corrupt (unparsable) record — never silently reads it as "not found"', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await storage.set(id!, 'not valid json {{{');

		await expect(getIntent(id!)).rejects.toThrow();
	});

	it('a genuinely never-enqueued id still reads as null — the one legitimate absence', async () => {
		expect(await getIntent('never-enqueued')).toBeNull();
	});
});

describe('intentsOf distinguishes an empty queue from a broken scan (§4)', () => {
	it('a whole-scan failure (storage.keys() itself throwing) propagates — never a silent empty list', async () => {
		_setIntentStorageForTests({
			async get() { return null; },
			async set() {},
			async delete() {},
			async keys() { throw new Error('indexeddb blocked'); },
			async clear() {},
		});

		await expect(intentsOf(A)).rejects.toThrow(/indexeddb blocked/i);
	});

	it('one corrupt record is reported as an issue and skipped — it does not hide this account\'s other, valid intents', async () => {
		const idGood = await enqueueIntent({ text: 'still readable' }, A, 'dialog_messages');
		await storage.set('corrupt-key', 'not valid json {{{');

		const { entries, issues } = await intentsOf(A);

		expect(entries.map((e) => e.id)).toEqual([idGood]);
		expect(issues).toContainEqual(expect.objectContaining({ key: 'corrupt-key', kind: 'corrupt' }));
	});

	it('one per-key read failure (e.g. a decrypt error) is reported as "foreign", not "corrupt", and still does not hide other valid intents', async () => {
		const idGood = await enqueueIntent({ text: 'still readable' }, A, 'dialog_messages');
		const realGet = storage.get.bind(storage);
		_setIntentStorageForTests({
			...storage,
			async get(k) {
				if (k === 'unreadable-key') throw new Error('[secureStore] cannot decrypt record');
				return realGet(k);
			},
			async keys() {
				return [...(await storage.keys()), 'unreadable-key'];
			},
		});

		const { entries, issues } = await intentsOf(A);

		expect(entries.map((e) => e.id)).toEqual([idGood]);
		expect(issues).toContainEqual(expect.objectContaining({ key: 'unreadable-key', kind: 'foreign' }));
	});

	it('a corrupt record is never deleted and never silently treated as accepted/resolved', async () => {
		await storage.set('corrupt-key', 'not valid json {{{');

		await intentsOf(A);

		expect(await storage.get('corrupt-key')).toBe('not valid json {{{');
	});
});

describe('account isolation (§3.11, same discipline from day one)', () => {
	it('intentsOf only returns the requested account\'s intents', async () => {
		const idA = await enqueueIntent({ text: 'a' }, A, 'dialog_messages');
		await enqueueIntent({ text: 'b' }, B, 'dialog_messages');

		const forA = (await intentsOf(A)).entries;
		expect(forA.map((e) => e.id)).toEqual([idA]);
		const forB = (await intentsOf(B)).entries;
		expect(forB).toHaveLength(1);
		expect(forB[0].userHash).toBe(B);
	});
});

describe('durability failure (ADR §11: fail visibly, never look queued)', () => {
	it('enqueueIntent returns null when storage is unavailable, does not throw', async () => {
		_setIntentStorageForTests({
			async get() { throw new Error('private mode'); },
			async set() { throw new Error('private mode'); },
			async delete() {},
			async keys() { throw new Error('private mode'); },
			async clear() {},
		});
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		expect(id).toBeNull();
	});

	it('returns null (never throws) for an empty userHash — nothing to own the intent', async () => {
		const id = await enqueueIntent({ text: 'x' }, '', 'dialog_messages');
		expect(id).toBeNull();
	});
});
