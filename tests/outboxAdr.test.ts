// ADR conformance for the outbox (PQ Mutation Lifecycle Contract).
//
// T-QUEUE-04: a 503 while the browser stays "online" must not strand the
// queue — the retry carries its own timer. T-QUEUE-05: a permanent rejection
// is quarantined, never silently deleted. §11: durability unavailable means a
// visible failure, not a best-effort send that looks like success.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IngestError } from '@/lib/data/ingest';
import {
	_setStorageForTests,
	_clearOutboxForTests,
	enqueue,
	drainOutbox,
	pendingEntries,
	quarantinedEntries,
	requeueEntry,
	discardEntry,
	recordFailure,
	ensureDrainLoop,
	stopDrainLoop,
} from '@/lib/data/outbox';

const MY = 'u_' + 'a'.repeat(128);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const mutation = (tag: string) => [{ syncMetadata: { relation: 'dialog_messages' }, modified: { content_b64: tag } }];
const permanentError = () => new IngestError('validation_failed', { permanent: true, status: 422 });

describe('T-QUEUE-05: permanent rejection quarantines', () => {
	beforeEach(async () => {
		_setStorageForTests(makeStorage());
		await _clearOutboxForTests();
	});

	it('keeps the signed mutations and the verdict instead of deleting', async () => {
		const id = await enqueue(mutation('rejected'), MY);
		await recordFailure(id, permanentError());

		expect(await pendingEntries(MY)).toHaveLength(0); // out of the replay path
		const q = await quarantinedEntries(MY);
		expect(q).toHaveLength(1);
		expect(q[0].lastError).toContain('validation_failed');
		expect(q[0].mutations).toEqual(mutation('rejected')); // the user's action survives
		expect(q[0].quarantinedAt).toBeGreaterThan(0);
	});

	it('a drain quarantines the rejected entry and still delivers the rest', async () => {
		await enqueue(mutation('bad'), MY);
		await enqueue(mutation('good'), MY);

		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => {
			const tag = (m as ReturnType<typeof mutation>)[0].modified.content_b64;
			if (tag === 'bad') throw permanentError();
			sent.push(tag);
		});

		expect(sent).toEqual(['good']);
		expect(result.dropped).toBe(1);
		expect(await quarantinedEntries(MY)).toHaveLength(1);
	});

	it('quarantine ends only by explicit requeue or discard', async () => {
		const id = await enqueue(mutation('x'), MY);
		await recordFailure(id, permanentError());

		// a later drain must not touch it
		await drainOutbox(MY, async () => { throw new Error('must not be called'); });
		expect(await quarantinedEntries(MY)).toHaveLength(1);

		// requeue: the state it failed against has changed — back into the path
		await requeueEntry(id!);
		expect(await pendingEntries(MY)).toHaveLength(1);
		const requeued = (await pendingEntries(MY))[0];
		expect(requeued.attempts).toBe(1); // history survives the requeue

		// and the explicit end of life
		await recordFailure(id, permanentError());
		await discardEntry(id!);
		expect(await quarantinedEntries(MY)).toHaveLength(0);
	});
});

describe('T-QUEUE-04: the retry carries its own timer', () => {
	beforeEach(async () => {
		_setStorageForTests(makeStorage());
		await _clearOutboxForTests();
		vi.useFakeTimers();
	});

	it('retries a transient failure on its own schedule, no external trigger', async () => {
		await enqueue(mutation('x'), MY);
		let failures = 2;
		const sent: unknown[] = [];
		ensureDrainLoop(MY, async (m) => {
			if (failures-- > 0) throw new Error('503, connectivity unchanged');
			sent.push(m);
		});
		try {
			// no login, no 'online' event — only time passes (backoff after two
			// failures sums to ~30s+jitter, so give it room)
			await vi.advanceTimersByTimeAsync(60_000);
			expect(sent).toHaveLength(1);
			expect(await pendingEntries(MY)).toHaveLength(0);
		} finally {
			stopDrainLoop();
			vi.useRealTimers();
		}
	});

	it('stops scheduling once the queue is empty', async () => {
		await enqueue(mutation('x'), MY);
		const calls: number[] = [];
		ensureDrainLoop(MY, async () => { calls.push(1); });
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			expect(calls).toHaveLength(1); // delivered on the first pass, then silence
		} finally {
			stopDrainLoop();
			vi.useRealTimers();
		}
	});

	it('stopDrainLoop cancels the pending timer (logout)', async () => {
		await enqueue(mutation('x'), MY);
		const calls: number[] = [];
		ensureDrainLoop(MY, async () => { calls.push(1); throw new Error('down'); });
		try {
			await vi.advanceTimersByTimeAsync(0);
			stopDrainLoop();
			await vi.advanceTimersByTimeAsync(600_000);
			expect(calls).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
