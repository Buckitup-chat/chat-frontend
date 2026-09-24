import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	enqueue, resolveEntry, recordFailure, discardEntry,
	readyEntries, blockedEntries, blockedDependentIssues, drainOutbox,
	_setStorageForTests, _setLeaderForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);

const mutation = (tag: string) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${tag}`, sender_hash: MY_HASH, content_b64: tag },
	syncMetadata: { relation: 'dialog_messages' },
}]);

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

let backing: ReturnType<typeof makeStorage>;

beforeEach(() => {
	backing = makeStorage();
	_setStorageForTests(backing);
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	vi.useRealTimers();
});

describe('a corrupt/missing/foreign dependency blocks its dependent, never resolves it (L17-01/R4)', () => {
	it('1. A pending, corrupted before B is scanned: transport count for B stays 0', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;

		backing.map.set(aId, 'not json');

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });

		expect(sent.some((m) => (m[0] as { modified: { message_id: string } }).modified.message_id === 'dmsg_B')).toBe(false);
		expect(result.sent).toBe(0);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('2. the same holds after a simulated reload (fresh storage handle over the same bytes)', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;
		backing.map.set(aId, 'not json');
		await readyEntries(MY_HASH); // triggers the corrupt cleanup

		_setStorageForTests({ ...backing });

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('3. a foreign/unreadable A never lets B dispatch', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;

		const realGet = backing.get.bind(backing);
		backing.get = async (k: string) => { if (k === aId) throw new Error('cannot decrypt'); return realGet(k); };

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
	});

	it('4. an explicit accepted marker for A makes B ready', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;

		await resolveEntry(aId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('5a. a quarantined A leaves B blocked', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;

		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('5b. a discarded A leaves B blocked', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;

		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await discardEntry(aId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('6. a missing dependency id (never even corrupt — simply never written) never becomes implicit acceptance, including after reload', async () => {
		const ghostId = `${Date.now().toString(36).padStart(9, '0')}-9999-ghst`;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [ghostId] }) as string;

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);

		_setStorageForTests({ ...backing });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('7. an unresolvable blocker is surfaced in the diagnostic read model, without a fabricated relation or error', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;
		backing.map.set(aId, 'not json');
		await readyEntries(MY_HASH); // triggers the corrupt cleanup

		const issues = await blockedDependentIssues(MY_HASH);
		const issue = issues.find((i) => i.entry.id === bId);

		expect(issue).toBeTruthy();
		expect(issue!.blockers).toHaveLength(1);
		expect(issue!.blockers[0]).toEqual({ id: aId, relation: 'unknown', status: 'unknown', lastError: null });
	});

	it('8. an unrelated, independent C keeps dispatching while B stays blocked on an unresolvable A', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;
		const cId = await enqueue(mutation('C'), MY_HASH) as string;
		backing.map.set(aId, 'not json');

		const sent: unknown[][] = [];
		await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });

		const sentIds = sent.map((m) => (m[0] as { modified: { message_id: string } }).modified.message_id);
		expect(sentIds).toContain('dmsg_C');
		expect(sentIds).not.toContain('dmsg_B');
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
		void cId;
	});
});

const writeLegacyDependent = async (
	backing: ReturnType<typeof makeStorage>,
	id: string,
	dependsOn: string[]
): Promise<void> => {
	const entry = {
		id,
		userHash: MY_HASH,
		relation: 'dialog_messages',
		mutations: mutation('legacy'),
		createdAt: Date.now(),
		attempts: 0,
		lastError: null,
		dependsOn,
	};
	await backing.set(id, JSON.stringify(entry));
};

describe('migration policy is an explicit, durable field on the dependent — never wall-clock time or an id\'s shape (L17-01/R4)', () => {
	it('1. a malformed dependency id blocks a current-format dependent as unknown, not accepted — the exact danger this review flagged', async () => {
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: ['bad-reference'] }) as string;

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
		const issues = await blockedDependentIssues(MY_HASH);
		expect(issues.find((i) => i.entry.id === bId)?.blockers).toEqual([
			{ id: 'bad-reference', relation: 'unknown', status: 'unknown', lastError: null },
		]);

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
	});

	it('2. a dependency id whose own embedded timestamp looks "old" still blocks a CURRENT-format dependent — the id\'s shape is irrelevant', async () => {
		const oldLookingTimestamp = Date.UTC(2020, 0, 1);
		const oldLookingId = `${oldLookingTimestamp.toString(36).padStart(9, '0')}-0000-oldd`;

		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [oldLookingId] }) as string;

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('3. a dependency id whose own embedded timestamp looks "new" still resolves for a LEGACY dependent — only its own field decides', async () => {
		const newLookingId = `${Date.now().toString(36).padStart(9, '0')}-0000-newd`;
		const legacyId = 'legacy-0001';
		await writeLegacyDependent(backing, legacyId, [newLookingId]);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(legacyId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).not.toContain(legacyId);
	});

	it('4. the client\'s system clock, set far in the past or future, never changes the verdict for either dependent kind', async () => {
		const missingId = `${Date.now().toString(36).padStart(9, '0')}-0000-miss`;
		const currentBId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [missingId] }) as string;
		const legacyId = 'legacy-0002';
		await writeLegacyDependent(backing, legacyId, [missingId]);

		for (const fakeNow of [Date.UTC(1999, 0, 1), Date.UTC(2099, 0, 1)]) {
			vi.useFakeTimers();
			vi.setSystemTime(fakeNow);
			try {
				expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(currentBId);
				expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(currentBId);
				expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(legacyId);
				expect((await blockedEntries(MY_HASH)).map((e) => e.id)).not.toContain(legacyId);
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it('8. a legacy dependent (pre-existing, no dependsOnDurableMarkers field) treats its missing prerequisite as accepted — no hardcoded date involved', async () => {
		const legacyId = 'legacy-0003';
		const neverWrittenDepId = 'some-old-format-id';
		await writeLegacyDependent(backing, legacyId, [neverWrittenDepId]);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(legacyId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).not.toContain(legacyId);
	});
});
