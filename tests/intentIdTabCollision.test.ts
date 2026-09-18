import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sharedMap = new Map<string, string>();
const sharedStorage = {
	async get(k: string) { return sharedMap.get(k) ?? null; },
	async set(k: string, v: string) { sharedMap.set(k, v); },
	async delete(k: string) { sharedMap.delete(k); },
	async keys() { return [...sharedMap.keys()]; },
	async clear() { sharedMap.clear(); },
};

const MY_HASH = 'u_' + 'a'.repeat(128);

beforeEach(() => {
	sharedMap.clear();
	vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('intents.ts: durable ids do not collide across tabs (§F-L09)', () => {
	it('two module instances (tabs) enqueuing their first intent in the same millisecond get different, coexisting ids', async () => {
		vi.resetModules();
		const tab1 = await import('@/lib/data/intents');
		tab1._setIntentStorageForTests(sharedStorage);
		const id1 = await tab1.enqueueIntent({ row: { text: 'from tab 1' } }, MY_HASH, 'dialog_messages');

		vi.resetModules();
		const tab2 = await import('@/lib/data/intents');
		tab2._setIntentStorageForTests(sharedStorage);
		const id2 = await tab2.enqueueIntent({ row: { text: 'from tab 2' } }, MY_HASH, 'dialog_messages');

		expect(id1).not.toBeNull();
		expect(id2).not.toBeNull();
		expect(id1).not.toBe(id2);

		expect(sharedMap.size).toBe(2);
		const entry1 = JSON.parse(sharedMap.get(id1!)!);
		const entry2 = JSON.parse(sharedMap.get(id2!)!);
		expect(entry1.intent.row.text).toBe('from tab 1');
		expect(entry2.intent.row.text).toBe('from tab 2');
	});
});
