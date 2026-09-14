// Durable intent (Detailed step plan §3.1): a user action becomes durable
// before it is signed. This is the level below outbox.ts's immutable signed
// snapshot — see src/lib/data/intents.ts for the full lifecycle contract.
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

		// "reload": a fresh storage object over the same underlying bytes —
		// nothing kept this alive in module memory alone.
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

		expect((await intentsOf(A)).length).toBe(1);
		expect((await getIntent(id!))?.intent).toEqual({ text: 'v3, final before send' });
	});

	it('resolveIntent ends the intent\'s life — it does not resurrect on the next read', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await resolveIntent(id!);

		expect(await getIntent(id!)).toBeNull();
		expect(await intentsOf(A)).toEqual([]);
	});

	it('updateIntent on an already-resolved (or unknown) id is a no-op, not a resurrection', async () => {
		const id = await enqueueIntent({ text: 'x' }, A, 'dialog_messages');
		await resolveIntent(id!);
		await updateIntent(id!, { text: 'too late' });

		expect(await getIntent(id!)).toBeNull();
	});

	it('is durable across reload before any signing happens — the point of §3.1', async () => {
		const id = await enqueueIntent({ refs: ['t1'], text: 'unsent' }, A, 'dialog_messages');
		_setIntentStorageForTests({ ...storage }); // reload
		const recovered = await getIntent(id!);
		expect(recovered).not.toBeNull();
		expect(recovered!.intent).toEqual({ refs: ['t1'], text: 'unsent' });
	});
});

describe('account isolation (§3.11, same discipline from day one)', () => {
	it('intentsOf only returns the requested account\'s intents', async () => {
		const idA = await enqueueIntent({ text: 'a' }, A, 'dialog_messages');
		await enqueueIntent({ text: 'b' }, B, 'dialog_messages');

		const forA = await intentsOf(A);
		expect(forA.map((e) => e.id)).toEqual([idA]);
		const forB = await intentsOf(B);
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
