import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	enqueue,
	pendingEntries,
	drainOutbox,
	resolveEntry,
	_setStorageForTests,
	_setLeaderForTests,
	MAX_OUTBOX_ENTRIES,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

// In-memory stand-in for IndexedDBAdapter: same StorageAdapter contract.
const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) {
			return map.get(k) ?? null;
		},
		async set(k: string, v: string) {
			map.set(k, v);
		},
		async delete(k: string) {
			map.delete(k);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
};

const USER_A = 'u_' + 'a'.repeat(128);
const USER_B = 'u_' + 'b'.repeat(128);

const mutation = (relation: string, text: string) => ({
	type: 'insert',
	modified: { text },
	syncMetadata: { relation },
});

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
	storage = makeStorage();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_setStorageForTests(storage as any);
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
});

describe('outbox durability', () => {
	it('an enqueued write survives until explicitly resolved', async () => {
		const id = await enqueue([mutation('dialog_messages', 'hello')], USER_A);
		expect(id).toBeTruthy();
		expect(await pendingEntries(USER_A)).toHaveLength(1);

		await resolveEntry(id);
		expect(await pendingEntries(USER_A)).toHaveLength(0);
	});

	it('entries are partitioned by the signing account', async () => {
		await enqueue([mutation('dialog_messages', 'mine')], USER_A);
		await enqueue([mutation('dialog_messages', 'theirs')], USER_B);

		expect(await pendingEntries(USER_A)).toHaveLength(1);
		expect(await pendingEntries(USER_B)).toHaveLength(1);
	});

	it('refuses to queue beyond the cap instead of dropping old entries', async () => {
		for (let i = 0; i < 3; i++) await enqueue([mutation('dialog_messages', `${i}`)], USER_A);
		// Simulate a full queue without 1000 real inserts.
		const realKeys = storage.keys.bind(storage);
		storage.keys = async () => new Array(MAX_OUTBOX_ENTRIES).fill('x');

		const id = await enqueue([mutation('dialog_messages', 'overflow')], USER_A);

		expect(id).toBeNull();
		storage.keys = realKeys;
		// The three originals are untouched — nothing was evicted.
		expect(await pendingEntries(USER_A)).toHaveLength(3);
	});
});

describe('MAX_OUTBOX_ENTRIES counts active work, not discarded terminal markers', () => {
	it('1000 discarded markers do not block a fresh active enqueue', async () => {
		for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
			storage.map.set(`discarded-${i}`, JSON.stringify({
				id: `discarded-${i}`, userHash: USER_A, relation: 'dialog_messages',
				mutations: [], createdAt: 1, attempts: 1, lastError: 'x',
				status: 'discarded', discardedAt: 1,
			}));
		}

		const id = await enqueue([mutation('dialog_messages', 'fresh')], USER_A);

		expect(id).not.toBeNull();
	});

	it('1000 active pending/quarantined entries still block the next enqueue', async () => {
		for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
			storage.map.set(`active-${i}`, JSON.stringify({
				id: `active-${i}`, userHash: USER_A, relation: 'dialog_messages',
				mutations: [mutation('dialog_messages', `m${i}`)], createdAt: 1, attempts: 0, lastError: null,
			}));
		}

		const id = await enqueue([mutation('dialog_messages', 'overflow')], USER_A);

		expect(id).toBeNull();
	});
});

describe('drainOutbox', () => {
	it('replays in insertion order and clears delivered entries', async () => {
		await enqueue([mutation('dialog_keys', 'k')], USER_A);
		await enqueue([mutation('dialog_messages', 'first')], USER_A);
		await enqueue([mutation('dialog_messages', 'second')], USER_A);

		const sentTexts: string[] = [];
		const result = await drainOutbox(USER_A, async (muts) => {
			sentTexts.push((muts[0] as { modified: { text: string } }).modified.text);
		});

		// Order is the correctness property: the key row must precede the
		// messages that need it, an edit must follow its message.
		expect(sentTexts).toEqual(['k', 'first', 'second']);
		expect(result).toMatchObject({ sent: 3, dropped: 0, remaining: 0, stoppedEarly: false });
		expect(await pendingEntries(USER_A)).toHaveLength(0);
	});

	it('a transient failure backs off only that entry — an unrelated ready entry in the same batch still dispatches (docs/main-tanstack-proposal-v3.md, "Ordering of operations": no global barrier)', async () => {
		await enqueue([mutation('dialog_messages', 'first')], USER_A);
		await enqueue([mutation('dialog_messages', 'second')], USER_A);

		const delivered: string[] = [];
		const result = await drainOutbox(USER_A, async (muts) => {
			const text = (muts[0] as { modified: { text: string } }).modified.text;
			if (text === 'first') throw new IngestError('network down', { permanent: false });
			delivered.push(text);
		});

		expect(delivered).toEqual(['second']);
		expect(result).toMatchObject({ sent: 1, dropped: 0, remaining: 1, stoppedEarly: true });
		expect(await pendingEntries(USER_A)).toHaveLength(1);
		const [remaining] = await pendingEntries(USER_A);
		expect((remaining.mutations[0] as { modified: { text: string } }).modified.text).toBe('first');
		expect(remaining.attempts).toBe(1);
	});

	it('a permanent rejection drops only that entry and continues', async () => {
		await enqueue([mutation('dialog_messages', 'poison')], USER_A);
		await enqueue([mutation('dialog_messages', 'good')], USER_A);

		const delivered: string[] = [];
		const result = await drainOutbox(USER_A, async (muts) => {
			const text = (muts[0] as { modified: { text: string } }).modified.text;
			if (text === 'poison') throw new IngestError('rejected', { permanent: true });
			delivered.push(text);
		});

		expect(delivered).toEqual(['good']);
		expect(result).toMatchObject({ sent: 1, dropped: 1, remaining: 0 });
		expect(await pendingEntries(USER_A)).toHaveLength(0);
	});

	it('does not replay another account\'s writes', async () => {
		await enqueue([mutation('dialog_messages', 'a-writes')], USER_A);
		await enqueue([mutation('dialog_messages', 'b-writes')], USER_B);

		const delivered: string[] = [];
		await drainOutbox(USER_A, async (muts) => {
			delivered.push((muts[0] as { modified: { text: string } }).modified.text);
		});

		expect(delivered).toEqual(['a-writes']);
		expect(await pendingEntries(USER_B)).toHaveLength(1);
	});

	it('failed attempts are recorded on the entry for diagnostics', async () => {
		await enqueue([mutation('dialog_messages', 'x')], USER_A);
		await drainOutbox(USER_A, async () => {
			throw new IngestError('timeout', { permanent: false });
		});

		const [entry] = await pendingEntries(USER_A);
		expect(entry.attempts).toBe(1);
		expect(entry.lastError).toMatch(/timeout/);
	});
});
