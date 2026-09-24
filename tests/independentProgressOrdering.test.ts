import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	enqueue, pendingEntries, readyEntries, quarantinedEntries, drainOutbox,
	startLeaderElection, stopLeaderElection, stopDrainLoop,
	_setStorageForTests, _setLeaderForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY = 'u_' + 'a'.repeat(128);

const makeMemoryStore = () => {
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

const mutation = (text: string) => ({
	type: 'insert',
	modified: { text },
	syncMetadata: { relation: 'dialog_messages' },
});

const textOf = (m: unknown[]) => (m[0] as { modified: { text: string } }).modified.text;

let storage: ReturnType<typeof makeMemoryStore>;

beforeEach(() => {
	storage = makeMemoryStore();
	_setStorageForTests(storage);
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

const forceEntryDue = async (id: string) => {
	const raw = await storage.get(id);
	if (!raw) throw new Error(`no such entry ${id}`);
	const parsed = JSON.parse(raw);
	parsed.nextAttemptAt = Date.now() - 1;
	await storage.set(id, JSON.stringify(parsed));
};

describe('independent progress: a transient failure blocks only its own dependents, never unrelated ready entries', () => {
	it('A fails transiently; B (depends on A) never calls HTTP; C and D (independent) are dispatched in the SAME drain trigger', async () => {
		const aId = await enqueue([mutation('A')], MY);
		const bId = await enqueue([mutation('B')], MY, { dependsOn: [aId!] });
		await enqueue([mutation('C')], MY);
		await enqueue([mutation('D')], MY);

		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => {
			const text = textOf(m);
			if (text === 'A') throw new IngestError('network down', { permanent: false });
			sent.push(text);
		});

		const [aEntry] = (await pendingEntries(MY)).filter((e) => textOf(e.mutations) === 'A');
		expect(aEntry.attempts).toBe(1);
		expect(aEntry.nextAttemptAt).toBeGreaterThan(Date.now());

		expect(sent).not.toContain('B');
		expect((await pendingEntries(MY)).some((e) => e.id === bId)).toBe(true);

		expect(sent).toEqual(['C', 'D']);

		expect(result.sent).toBe(2);
		expect(result.dropped).toBe(0);
		expect(result.remaining).toBe(2);

		expect((await readyEntries(MY)).map((e) => e.id)).not.toContain(aId);
	});

	it('once A\'s retry is accepted, B becomes ready and is dispatched in the SAME drain (bounded scheduler fills the freed slot immediately)', async () => {
		const aId = await enqueue([mutation('A')], MY);
		const bId = await enqueue([mutation('B')], MY, { dependsOn: [aId!] });

		const sent: string[] = [];
		let failA = true;
		const send = async (m: unknown[]) => {
			const text = textOf(m);
			if (text === 'A' && failA) throw new IngestError('network down', { permanent: false });
			sent.push(text);
		};

		await drainOutbox(MY, send);
		expect(sent).toEqual([]); // A failed, B still blocked

		failA = false;
		await forceEntryDue(aId!);
		const second = await drainOutbox(MY, send);
		expect(sent).toEqual(['A', 'B']);
		expect(second.sent).toBe(2);

		expect(await pendingEntries(MY)).toHaveLength(0);
		expect((await pendingEntries(MY)).some((e) => e.id === bId)).toBe(false);
	});

	it('a permanent rejection of A quarantines A and never sends dependent B, but never blocks unrelated C', async () => {
		const aId = await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY, { dependsOn: [aId!] });
		await enqueue([mutation('C')], MY);

		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => {
			const text = textOf(m);
			if (text === 'A') throw new IngestError('rejected', { permanent: true });
			sent.push(text);
		});

		expect(sent).toEqual(['C']);
		expect((await quarantinedEntries(MY)).map((e) => textOf(e.mutations))).toEqual(['A']);
		expect(result).toMatchObject({ sent: 1, dropped: 1 });
	});

	it('a transient failure of A never increases attempts on independent C when C succeeds', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('C')], MY);

		await drainOutbox(MY, async (m) => {
			if (textOf(m) === 'A') throw new IngestError('network down', { permanent: false });
		});

		expect(await pendingEntries(MY)).toHaveLength(1); // only A — C was resolved
		const [aEntry] = await pendingEntries(MY);
		expect(aEntry.attempts).toBe(1);
	});

	it('a live independent write enqueued while A is stuck in backoff is not blocked by it', async () => {
		const aId = await enqueue([mutation('A')], MY);
		await drainOutbox(MY, async (m) => {
			if (textOf(m) === 'A') throw new IngestError('network down', { permanent: false });
		});
		expect((await readyEntries(MY)).map((e) => e.id)).not.toContain(aId); // still backed off

		await enqueue([mutation('E')], MY); // a fresh, unrelated write arrives now
		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => { sent.push(textOf(m)); });

		expect(sent).toEqual(['E']); // dispatched despite A still being in backoff
		expect(result.sent).toBe(1);
	});

	it('reload with the same durable storage applies the same rules: A blocks only B, C and D still dispatch in the same pass', async () => {
		const aId = await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY, { dependsOn: [aId!] });
		await enqueue([mutation('C')], MY);
		await enqueue([mutation('D')], MY);

		_setStorageForTests({ ...storage });

		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => {
			const text = textOf(m);
			if (text === 'A') throw new IngestError('network down', { permanent: false });
			sent.push(text);
		});

		expect(sent).toEqual(['C', 'D']);
		expect(result.sent).toBe(2);
		expect(await pendingEntries(MY)).toHaveLength(2); // A + B remain
	});

	it('leader takeover (a fresh drainOutbox call as the new leader) applies the same dependency rules', async () => {
		const aId = await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY, { dependsOn: [aId!] });
		await enqueue([mutation('C')], MY);
		await enqueue([mutation('D')], MY);

		stopLeaderElection();
		startLeaderElection(MY, () => {});
		_setLeaderForTests(true);

		const sent: string[] = [];
		const result = await drainOutbox(MY, async (m) => {
			const text = textOf(m);
			if (text === 'A') throw new IngestError('network down', { permanent: false });
			sent.push(text);
		});

		expect(sent).toEqual(['C', 'D']); // same verdict as under the original leader
		expect(result.sent).toBe(2);
		expect(await pendingEntries(MY)).toHaveLength(2);
	});

	it('L17-10: a mutation that already reached the server is never sent a second time by this same ordering fix', async () => {
		await enqueue([mutation('A')], MY);
		const sent: string[] = [];
		const send = async (m: unknown[]) => { sent.push(textOf(m)); };

		await drainOutbox(MY, send);
		expect(sent).toEqual(['A']);

		await drainOutbox(MY, send);
		expect(sent).toEqual(['A']); // no second HTTP call — already terminal/accepted
	});
});
