// Acceptance contract for the phase-3 dispatch coordinator (ADR §7 v2,
// main-tanstack-proposal-v2 acceptance section). Written before the
// coordinator: an implementation is done when these pass, not when it demos.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { contractFor } from '@/lib/data/writeContracts';
import { IngestError } from '@/lib/data/ingest';
import {
	_setStorageForTests, _clearOutboxForTests,
	enqueue, recordFailure, resolveEntry, readyEntries, blockedEntries,
	pendingEntries, drainOutbox, ensureDrainLoop, stopDrainLoop,
} from '@/lib/data/outbox';

const MY = 'u_' + 'a'.repeat(128);

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

const mutation = (relation: string, tag: string, type = 'insert') =>
	[{ type, syncMetadata: { relation }, modified: { content_b64: tag } }];

let storage: ReturnType<typeof makeStorage>;

beforeEach(async () => {
	storage = makeStorage();
	_setStorageForTests(storage);
	await _clearOutboxForTests();
});

describe('write contracts pin the agreed barrier table', () => {
	it('the six uncontested operations wait for acceptance only', () => {
		for (const [relation, type] of [
			['user_cards', 'insert'], ['user_cards', 'update'],
			['dialog_keys', 'insert'],
			['dialog_message_reactions', 'insert'],
			['dialog_message_receipts', 'insert'],
			['files', 'insert'],
		] as const) {
			expect(contractFor(relation, type).confirmation, `${relation}/${type}`).toBe('accepted');
		}
	});

	it('the contested rows keep shape visibility until the coordinator decision', () => {
		for (const [relation, type] of [
			['dialog_messages', 'insert'], ['dialog_messages', 'update'],
			['user_storage', 'insert'], ['user_storage', 'update'],
			['dialog_message_reactions', 'update'],
		] as const) {
			expect(contractFor(relation, type).confirmation, `${relation}/${type}`).toBe('visible');
		}
	});

	it('an unknown relation gets the conservative fallback, never a weaker one', () => {
		expect(contractFor('brand_new_relation', 'insert'))
			.toEqual({ dependencyClass: 'chained', confirmation: 'visible' });
		expect(contractFor(undefined, undefined).confirmation).toBe('visible');
	});
});

describe('anti-head-of-line (the v2 regression scenario)', () => {
	it('a backoff blocks only its own dependents; unrelated writes stay ready', async () => {
		vi.useFakeTimers();
		try {
			// A: user_storage write that failed transiently → scheduled backoff
			const a = await enqueue(mutation('user_storage', 'profile'), MY, { scope: 'user_storage|u_a' });
			await recordFailure(a, new Error('503'));

			// B: independent message; C: an edit depending on A
			const b = await enqueue(mutation('dialog_messages', 'independent'), MY);
			const c = await enqueue(mutation('user_storage', 'dependent-edit'), MY, { dependsOn: [a!] });

			const ready = await readyEntries(MY);
			expect(ready.map((e) => e.id)).toEqual([b]); // A scheduled, C blocked
			expect((await blockedEntries(MY)).map((e) => e.id)).toEqual([c]);

			// A's schedule comes due → A ready, C still blocked behind it
			await vi.advanceTimersByTimeAsync(10_000);
			expect((await readyEntries(MY)).map((e) => e.id)).toEqual([a, b]);

			// A resolves → C unblocks
			await resolveEntry(a);
			expect((await readyEntries(MY)).map((e) => e.id)).toEqual([b, c]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a quarantined prerequisite keeps its dependents blocked, not racing ahead', async () => {
		const a = await enqueue(mutation('dialog_keys', 'key'), MY);
		const c = await enqueue(mutation('dialog_messages', 'msg'), MY, { dependsOn: [a!] });
		await recordFailure(a, new IngestError('validation_failed', { permanent: true, status: 422 }));

		expect((await readyEntries(MY)).map((e) => e.id)).toEqual([]);
		expect((await blockedEntries(MY)).map((e) => e.id)).toEqual([c]);
	});
});

describe('the retry schedule is durable state, not loop memory', () => {
	it('survives a reload: a new session resumes the same schedule', async () => {
		vi.useFakeTimers();
		try {
			const a = await enqueue(mutation('dialog_messages', 'x'), MY);
			await recordFailure(a, new Error('timeout'));
			const stored = JSON.parse(storage.map.get(a!)!);
			expect(stored.nextAttemptAt).toBeGreaterThan(Date.now());

			// "reload": a fresh storage adapter over the same bytes
			_setStorageForTests({ ...storage });
			expect((await readyEntries(MY)).length).toBe(0); // schedule intact
			await vi.advanceTimersByTimeAsync(10_000);
			expect((await readyEntries(MY)).map((e) => e.id)).toEqual([a]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('backoff grows per entry with its attempts', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_800_000_000_000);
		try {
			const a = await enqueue(mutation('dialog_messages', 'x'), MY);
			await recordFailure(a, new Error('503'));
			const first = JSON.parse(storage.map.get(a!)!).nextAttemptAt - Date.now();
			await recordFailure(a, new Error('503'));
			const second = JSON.parse(storage.map.get(a!)!).nextAttemptAt - Date.now();
			expect(first).toBeGreaterThanOrEqual(5_000);
			expect(second).toBeGreaterThanOrEqual(10_000);
			expect(second).toBeGreaterThan(first);
		} finally {
			vi.useRealTimers();
		}
	});

	it('an explicit trigger (login/online) resets schedules', async () => {
		vi.useFakeTimers();
		try {
			const a = await enqueue(mutation('dialog_messages', 'x'), MY);
			await recordFailure(a, new Error('offline'));
			expect((await readyEntries(MY)).length).toBe(0);

			const sent: unknown[][] = [];
			ensureDrainLoop(MY, async (m) => { sent.push(m); }, { resetSchedules: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(sent).toHaveLength(1); // due immediately, no 5s hostage
		} finally {
			stopDrainLoop();
			vi.useRealTimers();
		}
	});
});

describe('dispatch replays the exact captured bytes', () => {
	it('what was enqueued is what is sent, regardless of what changed since', async () => {
		const original = mutation('dialog_messages', 'captured-scope-tag');
		await enqueue(original, MY);
		// the world moves on; the entry must not
		(original[0].modified as Record<string, unknown>).content_b64 = 'MUTATED AFTER ENQUEUE';

		const sent: unknown[][] = [];
		await drainOutbox(MY, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(1);
		expect((sent[0][0] as { modified: { content_b64: string } }).modified.content_b64)
			.toBe('captured-scope-tag');
	});
});

describe('drain over the ready set', () => {
	it('scheduled and blocked entries are remaining, not failures', async () => {
		vi.useFakeTimers();
		try {
			const a = await enqueue(mutation('user_storage', 'a'), MY);
			await recordFailure(a, new Error('503'));
			const b = await enqueue(mutation('dialog_messages', 'b'), MY);
			await enqueue(mutation('user_storage', 'c'), MY, { dependsOn: [a!] });

			const sent: unknown[][] = [];
			const result = await drainOutbox(MY, async (m) => { sent.push(m as unknown[]); });
			expect(sent).toHaveLength(1); // only B
			expect(result.dropped).toBe(0);
			expect(result.remaining).toBe(2); // A scheduled + C blocked, both alive
			expect((await pendingEntries(MY)).length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
