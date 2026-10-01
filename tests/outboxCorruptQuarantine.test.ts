import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	enqueue, pendingEntries, readyEntries, blockedEntries, blockedDependentIssues, quarantinedEntries,
	drainOutbox, discardEntry, requeueEntry, recordFailure, markServerAccepted, resolveEntry,
	corruptOutboxRecords, discardCorruptOutboxRecord, deviceOutboxDiagnostics, discardUnknownOwnerOutboxRecord,
	accountOutboxSnapshot, onOutboxChange, awaitEntryOutcome, MAX_OUTBOX_ENTRIES,
	_setStorageForTests, _setLeaderForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';
import { createSecureStore, deriveLocalStorageKey, type StringStore } from '@/lib/data/secureStore';

const USER_A = 'u_' + 'a'.repeat(128);
const USER_B = 'u_' + 'b'.repeat(128);

const mutation = (tag: string) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${tag}` },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const sentIds = (sent: unknown[][]) => sent.map((m) => (m[0] as { modified: { message_id: string } }).modified.message_id);

const makeRaw = (): StringStore & { map: Map<string, string>; writes: string[] } => {
	const map = new Map<string, string>();
	const writes: string[] = [];
	return {
		map,
		writes,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { writes.push(k); map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const quarantineKeys = (raw: { map: Map<string, string> }) => [...raw.map.keys()].filter((k) => k.startsWith('quarantine|'));

const drainCollecting = async (userHash: string) => {
	const sent: unknown[][] = [];
	const result = await drainOutbox(userHash, async (m) => { sent.push(m); });
	return { sent, result };
};

const rewriteEntry = (raw: { map: Map<string, string> }, id: string, change: (e: Record<string, unknown>) => void): string => {
	const entry = JSON.parse(raw.map.get(id) as string);
	change(entry);
	const value = JSON.stringify(entry);
	raw.map.set(id, value);
	return value;
};

let raw: ReturnType<typeof makeRaw>;

beforeEach(() => {
	raw = makeRaw();
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
});

describe('plain store: corrupt records are retained and quarantined, never deleted', () => {
	beforeEach(() => _setStorageForTests(raw));

	it('a damaged freshly enqueued record stays its owner\'s through the owner record, even with no userHash left in it', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		raw.map.set(id, 'not json');

		expect(await pendingEntries(USER_A)).toHaveLength(0);
		expect(raw.map.get(id)).toBe('not json');
		expect(await corruptOutboxRecords(USER_A)).toEqual([expect.objectContaining({ key: id, ownerHash: USER_A, failure: 'undecodable', raw: 'not json' })]);
		expect(await corruptOutboxRecords(USER_B)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([]);
	});

	it('malformed JSON with no owner proof is retained and goes to the device-level unknown-owner bucket only', async () => {
		const id = '000000001-0000-noow';
		raw.map.set(id, 'not json');

		expect(await pendingEntries(USER_A)).toHaveLength(0);
		expect(raw.map.get(id)).toBe('not json');
		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect((await accountOutboxSnapshot(USER_A)).corrupt).toEqual([]);

		const diagnostics = await deviceOutboxDiagnostics();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ kind: 'unknown_owner', key: id, ownerHash: null, failure: 'undecodable' });
		expect(diagnostics[0]).not.toHaveProperty('raw');
		expect(JSON.stringify(diagnostics)).not.toContain('not json');
	});

	it('a truncated record keeps its proven owner', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		const stored = raw.map.get(id) as string;
		const truncated = stored.slice(0, stored.indexOf('"mutations"') + 14);
		raw.map.set(id, truncated);

		const [record] = await corruptOutboxRecords(USER_A);
		expect(record).toMatchObject({ key: id, ownerHash: USER_A, failure: 'undecodable', raw: truncated });
		expect(record.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await corruptOutboxRecords(USER_B)).toEqual([]);
	});

	it('reload does not create another quarantine record, and keeps the first detection time', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		rewriteEntry(raw, id, (e) => { e.attempts = 'many'; });

		const [first] = await corruptOutboxRecords(USER_A);
		await readyEntries(USER_A);
		await drainCollecting(USER_A);
		_setStorageForTests({ ...raw });
		const again = await corruptOutboxRecords(USER_A);

		expect(quarantineKeys(raw)).toEqual([`quarantine|${id}`]);
		expect(again).toEqual([first]);
		expect(raw.writes.filter((k) => k === `quarantine|${id}`)).toHaveLength(1);
	});

	it('drain never sends the corrupt record, and an unrelated valid entry still goes out', async () => {
		const corruptId = await enqueue(mutation('A'), USER_A) as string;
		await enqueue(mutation('C'), USER_A);
		const damaged = rewriteEntry(raw, corruptId, (e) => { e.mutations = [null]; });

		const { sent, result } = await drainCollecting(USER_A);

		expect(sentIds(sent)).toEqual(['dmsg_C']);
		expect(result.sent).toBe(1);
		expect(result.remaining).toBe(0);
		expect(raw.map.get(corruptId)).toBe(damaged);
		expect(await quarantinedEntries(USER_A)).toEqual([]); // not a server rejection, not a replayable entry
	});

	it('a valid dependent stays blocked on a corrupt predecessor and says why', async () => {
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		raw.map.set(aId, 'not json');

		const { sent } = await drainCollecting(USER_A);

		expect(sent).toHaveLength(0);
		expect((await blockedEntries(USER_A)).map((e) => e.id)).toEqual([bId]);
		const [issue] = await blockedDependentIssues(USER_A);
		expect(issue.blockers).toEqual([{ id: aId, relation: 'unknown', status: 'corrupt', lastError: 'stored value is not valid JSON' }]);
	});

	it('a legacy dependent (no durable-marker field) is not released by a corrupt predecessor either', async () => {
		const aId = await enqueue(mutation('A'), USER_A) as string;
		raw.map.set(aId, 'not json');
		const legacyId = 'legacy-0001';
		raw.map.set(legacyId, JSON.stringify({
			id: legacyId, userHash: USER_A, relation: 'dialog_messages', mutations: mutation('L'),
			createdAt: 1, attempts: 0, lastError: null, dependsOn: [aId],
		}));

		const { sent } = await drainCollecting(USER_A);

		expect(sent).toHaveLength(0);
		expect((await blockedEntries(USER_A)).map((e) => e.id)).toEqual([legacyId]);
	});

	it('no lifecycle call overwrites or removes the corrupt record — only the explicit discard does', async () => {
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		const damaged = rewriteEntry(raw, aId, (e) => { e.status = 'bogus'; });
		await corruptOutboxRecords(USER_A);

		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await recordFailure(aId, new Error('503'));
		await markServerAccepted(aId);
		await resolveEntry(aId);
		await requeueEntry(aId);
		await discardEntry(aId);
		for (let i = 0; i < 3; i++) await drainCollecting(USER_A);

		expect(raw.map.get(aId)).toBe(damaged);
		expect(quarantineKeys(raw)).toHaveLength(1);

		expect(await discardCorruptOutboxRecord(USER_A, aId)).toBe(true);

		expect(quarantineKeys(raw)).toEqual([]);
		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect((await blockedEntries(USER_A)).map((e) => e.id)).toEqual([bId]);
		const [issue] = await blockedDependentIssues(USER_A);
		expect(issue.blockers[0]).toMatchObject({ id: aId, status: 'discarded' });
		expect((await drainCollecting(USER_A)).sent).toHaveLength(0);
	});

	it('unknown-owner evidence is removed only by the explicit device-level discard', async () => {
		const id = '000000001-0000-noow';
		raw.map.set(id, 'not json');
		await deviceOutboxDiagnostics();

		expect(await discardCorruptOutboxRecord(USER_A, id)).toBe(false);
		expect(await discardCorruptOutboxRecord(USER_B, id)).toBe(false);
		expect(raw.map.get(id)).toBe('not json');

		expect(await discardUnknownOwnerOutboxRecord(id)).toBe(true);
		expect(raw.map.has(id)).toBe(false);
		expect(quarantineKeys(raw)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([]);
	});

	it('the device-level discard refuses an owned record', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		const damaged = rewriteEntry(raw, id, (e) => { e.createdAt = 'yesterday'; });
		await corruptOutboxRecords(USER_A);

		expect(await discardUnknownOwnerOutboxRecord(id)).toBe(false);
		expect(raw.map.get(id)).toBe(damaged);
	});

	it('another account can neither see nor discard an owned corrupt record, nor count it', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		rewriteEntry(raw, id, (e) => { e.attempts = 'many'; });
		await corruptOutboxRecords(USER_A);

		expect(await corruptOutboxRecords(USER_B)).toEqual([]);
		expect((await accountOutboxSnapshot(USER_B)).corrupt).toEqual([]);
		expect(await discardCorruptOutboxRecord(USER_B, id)).toBe(false);
		expect(raw.map.has(id)).toBe(true);
		expect((await corruptOutboxRecords(USER_A)).map((r) => r.key)).toEqual([id]);
	});
});

describe('every persisted field is validated before an entry can reach transport', () => {
	beforeEach(() => _setStorageForTests(raw));

	type Case = [name: string, change: (e: Record<string, unknown>) => void, reason: string];
	const cases: Case[] = [
		['id that is not the storage key', (e) => { e.id = 'someone-else'; }, 'id does not match its storage key'],
		['empty userHash', (e) => { e.userHash = ''; }, 'userHash is missing'],
		['non-string userHash', (e) => { e.userHash = 42; }, 'userHash is missing'],
		['non-string relation', (e) => { e.relation = 5; }, 'relation is missing'],
		['empty relation', (e) => { e.relation = ''; }, 'relation is missing'],
		['mutations that is not a list', (e) => { e.mutations = 'x'; }, 'mutations is not a list'],
		['string createdAt', (e) => { e.createdAt = '1'; }, 'createdAt is not a number'],
		['negative attempts', (e) => { e.attempts = -1; }, 'attempts is not a non-negative integer'],
		['fractional attempts', (e) => { e.attempts = 1.5; }, 'attempts is not a non-negative integer'],
		['numeric lastError', (e) => { e.lastError = 7; }, 'lastError is not a string'],
		['missing lastError', (e) => { delete e.lastError; }, 'lastError is not a string'],
		['unknown status', (e) => { e.status = 'bogus'; }, 'status is unknown'],
		['string quarantinedAt', (e) => { e.quarantinedAt = 'x'; }, 'quarantinedAt is not a number'],
		['string discardedAt', (e) => { e.discardedAt = 'x'; }, 'discardedAt is not a number'],
		['string acceptedAt', (e) => { e.acceptedAt = 'x'; }, 'acceptedAt is not a number'],
		['string serverAcceptedAt', (e) => { e.serverAcceptedAt = 'x'; }, 'serverAcceptedAt is not a number'],
		['string reconciledAt', (e) => { e.reconciledAt = 'x'; }, 'reconciledAt is not a number'],
		['string nextAttemptAt', (e) => { e.nextAttemptAt = 'soon'; }, 'nextAttemptAt is not a number'],
		['infinite nextAttemptAt', (e) => { e.nextAttemptAt = null; }, 'nextAttemptAt is not a number'],
		['quarantined without quarantinedAt', (e) => { e.status = 'quarantined'; }, 'status quarantined has no quarantinedAt'],
		['server-accepted without serverAcceptedAt', (e) => { e.status = 'server_accepted_pending_reconcile'; }, 'status server_accepted_pending_reconcile has no serverAcceptedAt'],
		['accepted without acceptedAt', (e) => { e.status = 'accepted'; e.mutations = []; }, 'status accepted has no acceptedAt'],
		['discarded without discardedAt', (e) => { e.status = 'discarded'; e.mutations = []; }, 'status discarded has no discardedAt'],
		['dependsOn that is not a list', (e) => { e.dependsOn = 'a'; }, 'dependsOn is not a list of ids'],
		['dependsOn with a number', (e) => { e.dependsOn = [1]; }, 'dependsOn is not a list of ids'],
		['dependsOn with an empty id', (e) => { e.dependsOn = ['']; }, 'dependsOn is not a list of ids'],
		['dependsOnDurableMarkers false', (e) => { e.dependsOnDurableMarkers = false; }, 'dependsOnDurableMarkers is not true'],
		['numeric scope', (e) => { e.scope = 3; }, 'scope is not a string'],
		['empty sourceIntentId', (e) => { e.sourceIntentId = ''; }, 'sourceIntentId is not an id'],
		['numeric sourceIntentId', (e) => { e.sourceIntentId = 5; }, 'sourceIntentId is not an id'],
		['no mutations on a pending entry', (e) => { e.mutations = []; }, 'mutations is empty'],
		['a null mutation', (e) => { e.mutations = [null]; }, 'mutation 0 is not an object'],
		['a numeric mutation', (e) => { e.mutations = [42]; }, 'mutation 0 is not an object'],
		['a mutation list', (e) => { e.mutations = [[]]; }, 'mutation 0 is not an object'],
		['a mutation without type', (e) => { e.mutations = [{ modified: {}, syncMetadata: { relation: 'r' } }]; }, 'mutation 0 has no valid operation type'],
		['an unknown operation type', (e) => { e.mutations = [{ type: 'upsert', modified: {}, syncMetadata: { relation: 'r' } }]; }, 'mutation 0 has no valid operation type'],
		['a mutation without syncMetadata', (e) => { e.mutations = [{ type: 'insert', modified: {} }]; }, 'mutation 0 has no syncMetadata.relation'],
		['an empty syncMetadata.relation', (e) => { e.mutations = [{ type: 'insert', modified: {}, syncMetadata: { relation: '' } }]; }, 'mutation 0 has no syncMetadata.relation'],
		['an insert without modified', (e) => { e.mutations = [{ type: 'insert', syncMetadata: { relation: 'r' } }]; }, 'mutation 0 is an insert without a modified row'],
		['an insert whose modified is a list', (e) => { e.mutations = [{ type: 'insert', modified: [], syncMetadata: { relation: 'r' } }]; }, 'mutation 0 is an insert without a modified row'],
		['an update without original', (e) => { e.mutations = [{ type: 'update', changes: {}, syncMetadata: { relation: 'r' } }]; }, 'mutation 0 is an update without original and changes'],
		['an update without changes', (e) => { e.mutations = [{ type: 'update', original: {}, syncMetadata: { relation: 'r' } }]; }, 'mutation 0 is an update without original and changes'],
		['a delete without original', (e) => { e.mutations = [{ type: 'delete', syncMetadata: { relation: 'r' } }]; }, 'mutation 0 is a delete without an original row'],
		['a bad second mutation', (e) => { e.mutations = [...(e.mutations as unknown[]), null]; }, 'mutation 1 is not an object'],
	];

	it.each(cases)('%s is retained, quarantined, and never sent', async (_name, change, reason) => {
		const id = await enqueue(mutation('bad'), USER_A) as string;
		await enqueue(mutation('ok'), USER_A);
		const damaged = rewriteEntry(raw, id, change);

		const { sent } = await drainCollecting(USER_A);

		expect(sentIds(sent)).toEqual(['dmsg_ok']);
		expect(raw.map.get(id)).toBe(damaged);
		const message = `decoded value is not a valid outbox entry: ${reason}`;
		expect(await corruptOutboxRecords(USER_A)).toEqual([expect.objectContaining({ key: id, ownerHash: USER_A, failure: 'invalid_entry', message, raw: damaged })]);
	});

	it('an entry using every optional field with valid values is still replayed', async () => {
		const depId = await enqueue(mutation('dep'), USER_A) as string;
		await drainCollecting(USER_A);
		const id = await enqueue(mutation('full'), USER_A, { dependsOn: [depId], scope: 'dialog:x', sourceIntentId: 'intent-1' }) as string;
		rewriteEntry(raw, id, (e) => {
			Object.assign(e, { status: 'pending', nextAttemptAt: 1, reconciledAt: undefined, attempts: 2, lastError: 'ingest HTTP 503' });
			e.mutations = [
				{ type: 'update', original: { message_id: 'm' }, changes: { content_b64: 'x' }, syncMetadata: { relation: 'dialog_messages' } },
				{ type: 'delete', original: { message_id: 'm2' }, syncMetadata: { relation: 'dialog_messages' } },
			];
		});

		expect((await readyEntries(USER_A)).map((e) => e.id)).toEqual([id]);
		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
	});
});

describe('a per-record read failure is unavailable, not absent', () => {
	const failFor = (target: string) => {
		const realGet = raw.get.bind(raw);
		raw.get = async (k) => { if (k === target) throw new Error('disk read error'); return realGet(k); };
		return () => { raw.get = realGet; };
	};

	beforeEach(() => _setStorageForTests(raw));

	it('blocks durable and legacy dependents, lets unrelated work go, persists nothing, and is retried on the next scan', async () => {
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		await enqueue(mutation('C'), USER_A);
		const legacyId = 'legacy-0001';
		raw.map.set(legacyId, JSON.stringify({
			id: legacyId, userHash: USER_A, relation: 'dialog_messages', mutations: mutation('L'),
			createdAt: 1, attempts: 0, lastError: null, dependsOn: [aId],
		}));
		const restore = failFor(aId);

		const { sent } = await drainCollecting(USER_A);

		expect(sentIds(sent)).toEqual(['dmsg_C']);
		expect((await blockedEntries(USER_A)).map((e) => e.id).sort()).toEqual([bId, legacyId].sort());
		const issue = (await blockedDependentIssues(USER_A)).find((i) => i.entry.id === bId);
		expect(issue?.blockers).toEqual([{ id: aId, relation: 'unknown', status: 'unavailable', lastError: 'stored record could not be read: storage unavailable' }]);
		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(quarantineKeys(raw)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([{ kind: 'unavailable', key: aId, message: 'stored record could not be read: storage unavailable' }]);

		restore();
		const after = await drainCollecting(USER_A);
		expect(sentIds(after.sent).sort()).toEqual(['dmsg_A', 'dmsg_B', 'dmsg_L'].sort());
	});
});

describe('capacity counts only this account\'s work', () => {
	beforeEach(() => _setStorageForTests(raw));

	it('another account\'s entries, unknown-owner corrupt records and quarantine metadata do not fill this account\'s share', async () => {
		for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++) {
			raw.map.set(`b-${i}`, JSON.stringify({
				id: `b-${i}`, userHash: USER_B, relation: 'dialog_messages', mutations: mutation(`b${i}`),
				createdAt: 1, attempts: 0, lastError: null,
			}));
			raw.map.set(`junk-${i}`, 'not json');
		}
		await deviceOutboxDiagnostics();

		const id = await enqueue(mutation('mine'), USER_A);

		expect(id).not.toBeNull();
		expect(raw.map.size).toBeGreaterThan(3 * MAX_OUTBOX_ENTRIES);
	});

	it('this account\'s own corrupt records do count, and hitting the cap evicts nothing', async () => {
		for (let i = 0; i < MAX_OUTBOX_ENTRIES - 1; i++) {
			raw.map.set(`a-${i}`, JSON.stringify({
				id: `a-${i}`, userHash: USER_A, relation: 'dialog_messages', mutations: mutation(`a${i}`),
				createdAt: 1, attempts: 0, lastError: null,
			}));
		}
		raw.map.set('a-bad', JSON.stringify({ id: 'a-bad', userHash: USER_A, mutations: 'x' }));
		raw.map.set('owner|a-bad', JSON.stringify({ userHash: USER_A }));
		const before = new Map(raw.map);

		expect(await enqueue(mutation('overflow'), USER_A)).toBeNull();
		for (const [k, v] of before) expect(raw.map.get(k)).toBe(v);
	});
});

describe('concurrent first detection creates one stable diagnosis', () => {
	it('plain store: five concurrent scans write the metadata once and notify once', async () => {
		_setStorageForTests(raw);
		const id = await enqueue(mutation('A'), USER_A) as string;
		rewriteEntry(raw, id, (e) => { e.mutations = [null]; });
		raw.writes.length = 0;
		const notified: string[] = [];
		const unsubscribe = onOutboxChange((u) => notified.push(u));

		const [, , first, second, snapshot] = await Promise.all([
			readyEntries(USER_A), pendingEntries(USER_A), corruptOutboxRecords(USER_A), corruptOutboxRecords(USER_A), accountOutboxSnapshot(USER_A),
		]);
		unsubscribe();

		expect(raw.writes.filter((k) => k === `quarantine|${id}`)).toHaveLength(1);
		expect(new Set([first[0].detectedAt, second[0].detectedAt, snapshot.corrupt[0].detectedAt]).size).toBe(1);
		expect(notified).toEqual([USER_A]);
	});

	it('encrypted store: concurrent scans agree on one sealed record', async () => {
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		const secure = createSecureStore(raw, { getKey: async () => key });
		_setStorageForTests(secure, raw);
		await secure.set('000000001-0000-bad0', 'not json');
		raw.writes.length = 0;

		const results = await Promise.all(Array.from({ length: 4 }, () => corruptOutboxRecords(USER_A)));

		expect(raw.writes.filter((k) => k === 'quarantine|000000001-0000-bad0')).toHaveLength(1);
		expect(new Set(results.map((r) => r[0].detectedAt)).size).toBe(1);
		expect(raw.map.get('quarantine|000000001-0000-bad0')?.startsWith('{')).toBe(false);
	});
});

describe('encrypted store: ownership, isolation and undecryptable ciphertext', () => {
	const useAccount = async (seed: number) => {
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(seed));
		_setStorageForTests(createSecureStore(raw, { getKey: async () => key }), raw);
		return key;
	};

	const flipCiphertext = (id: string) => {
		const value = raw.map.get(id) as string;
		const i = value.length - 6;
		const flipped = value[i] === 'A' ? 'B' : 'A';
		raw.map.set(id, value.slice(0, i) + flipped + value.slice(i + 1));
		return raw.map.get(id) as string;
	};

	it('every new entry gets a sealed owner record', async () => {
		await useAccount(1);
		const id = await enqueue(mutation('A'), USER_A) as string;

		const owner = raw.map.get(`owner|${id}`) as string;
		expect(owner).toBeTruthy();
		expect(owner).not.toContain(USER_A);
	});

	it('a record that decrypts but does not parse belongs to the decrypting account, and its metadata is sealed', async () => {
		const key = await useAccount(1);
		await createSecureStore(raw, { getKey: async () => key }).set('000000001-0000-bad0', 'not json');
		const ciphertext = raw.map.get('000000001-0000-bad0');

		const [record] = await corruptOutboxRecords(USER_A);

		expect(record).toMatchObject({ key: '000000001-0000-bad0', ownerHash: USER_A, failure: 'undecodable', raw: ciphertext });
		const metadataOnDisk = raw.map.get('quarantine|000000001-0000-bad0') as string;
		expect(metadataOnDisk).not.toContain(USER_A);
		expect(metadataOnDisk).not.toContain('undecodable');
	});

	it('standalone damaged ciphertext is quarantined as its owner\'s through the owner record, and never sent', async () => {
		await useAccount(1);
		const aId = await enqueue(mutation('A'), USER_A) as string;
		await enqueue(mutation('C'), USER_A);
		const damaged = flipCiphertext(aId);

		const { sent } = await drainCollecting(USER_A);

		expect(sentIds(sent)).toEqual(['dmsg_C']);
		expect(raw.map.get(aId)).toBe(damaged);
		const [record] = await corruptOutboxRecords(USER_A);
		expect(record).toMatchObject({ key: aId, ownerHash: USER_A, failure: 'undecryptable', raw: damaged });
		expect((await accountOutboxSnapshot(USER_A)).corrupt.map((r) => r.key)).toEqual([aId]);
	});

	it('the owner record survives a reload, so the attribution does too', async () => {
		await useAccount(1);
		const aId = await enqueue(mutation('A'), USER_A) as string;
		flipCiphertext(aId);

		await useAccount(1);
		expect((await corruptOutboxRecords(USER_A)).map((r) => r.key)).toEqual([aId]);
	});

	it('an older entry without an owner record gets one backfilled while it still decrypts', async () => {
		await useAccount(1);
		const aId = await enqueue(mutation('A'), USER_A) as string;
		raw.map.delete(`owner|${aId}`);

		await pendingEntries(USER_A);
		expect(raw.map.has(`owner|${aId}`)).toBe(true);

		flipCiphertext(aId);
		expect((await corruptOutboxRecords(USER_A)).map((r) => r.key)).toEqual([aId]);
	});

	it('pre-owner-record ciphertext named by this account\'s dependent is still quarantined; the dependent stays blocked', async () => {
		await useAccount(1);
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		raw.map.delete(`owner|${aId}`);
		const damaged = flipCiphertext(aId);

		const { sent } = await drainCollecting(USER_A);

		expect(sent).toHaveLength(0);
		expect((await blockedEntries(USER_A)).map((e) => e.id)).toEqual([bId]);
		expect(await corruptOutboxRecords(USER_A)).toEqual([expect.objectContaining({ key: aId, failure: 'undecryptable', raw: damaged })]);
	});

	it('another account\'s entries are opaque, not corrupt: never quarantined, never device-level', async () => {
		await useAccount(2);
		await enqueue(mutation('B'), USER_B);
		await useAccount(1);
		await enqueue(mutation('A'), USER_A);

		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([]);
		expect(quarantineKeys(raw)).toEqual([]);
	});

	it('damaged ciphertext of another account is not attributed to the active one', async () => {
		await useAccount(2);
		const bId = await enqueue(mutation('B'), USER_B) as string;
		flipCiphertext(bId);
		await useAccount(1);

		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([]);
		expect(quarantineKeys(raw)).toEqual([]);
	});

	it('legacy opaque ciphertext with no owner record is only a device-level diagnostic: kept, not attributed, not discardable', async () => {
		await useAccount(2);
		const bId = await enqueue(mutation('B'), USER_B) as string;
		raw.map.delete(`owner|${bId}`);
		const opaque = raw.map.get(bId);
		await useAccount(1);

		expect(await enqueue(mutation('A'), USER_A)).not.toBeNull();
		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([{ kind: 'unattributed_ciphertext', key: bId }]);
		expect(await discardUnknownOwnerOutboxRecord(bId)).toBe(false);
		expect(await discardCorruptOutboxRecord(USER_A, bId)).toBe(false);
		expect(raw.map.get(bId)).toBe(opaque);

		await useAccount(2);
		expect((await pendingEntries(USER_B)).map((e) => e.id)).toEqual([bId]);
	});

	it('switching accounts neither exposes nor permits discarding known-owner or unknown-owner evidence', async () => {
		const keyA = await useAccount(1);
		await createSecureStore(raw, { getKey: async () => keyA }).set('000000001-0000-bad0', '{"half":');
		raw.map.set('000000001-0000-unk0', '{"no owner":');
		await corruptOutboxRecords(USER_A);
		await deviceOutboxDiagnostics();
		const before = new Map(raw.map);

		await useAccount(2);
		await enqueue(mutation('B'), USER_B);
		expect(await corruptOutboxRecords(USER_B)).toEqual([]);
		expect((await accountOutboxSnapshot(USER_B)).corrupt).toEqual([]);
		expect(await discardCorruptOutboxRecord(USER_B, '000000001-0000-bad0')).toBe(false);
		expect(await discardCorruptOutboxRecord(USER_B, '000000001-0000-unk0')).toBe(false);
		const { sent } = await drainCollecting(USER_B);
		expect(sentIds(sent)).toEqual(['dmsg_B']);

		for (const [k, v] of before) expect(raw.map.get(k)).toBe(v);
		await useAccount(1);
		expect((await corruptOutboxRecords(USER_A)).map((r) => r.key)).toEqual(['000000001-0000-bad0']);
		expect((await deviceOutboxDiagnostics()).map((d) => d.kind === 'unknown_owner' && d.key)).toContain('000000001-0000-unk0');
	});
});

describe('owner records live exactly as long as their entry', () => {
	it('a failed entry write leaves no orphaned owner record', async () => {
		_setStorageForTests(raw);
		const realSet = raw.set.bind(raw);
		raw.set = async (k, v) => { if (!k.startsWith('owner|')) throw new Error('disk full'); return realSet(k, v); };

		expect(await enqueue(mutation('A'), USER_A)).toBeNull();
		expect([...raw.map.keys()]).toEqual([]);
	});

	it('terminal markers keep their owner record', async () => {
		_setStorageForTests(raw);
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A) as string;
		await resolveEntry(aId);
		await discardEntry(bId);

		expect(raw.map.has(`owner|${aId}`)).toBe(true);
		expect(raw.map.has(`owner|${bId}`)).toBe(true);
	});
});

describe('ownership of a corrupt record must be proven, never claimed by its payload', () => {
	beforeEach(() => _setStorageForTests(raw));

	it('malformed plaintext naming an arbitrary account cannot attribute itself to it', async () => {
		const forged = '000000001-0000-forg';
		raw.map.set(forged, `{"id":"${forged}","userHash":"${USER_B}","mutations":[`);
		const invalid = '000000001-0000-inva';
		raw.map.set(invalid, JSON.stringify({ id: invalid, userHash: USER_B, relation: 'dialog_messages', mutations: [null], createdAt: 1, attempts: 0, lastError: null }));
		for (let i = 0; i < MAX_OUTBOX_ENTRIES - 1; i++) {
			raw.map.set(`b-${i}`, JSON.stringify({ id: `b-${i}`, userHash: USER_B, relation: 'dialog_messages', mutations: mutation(`b${i}`), createdAt: 1, attempts: 0, lastError: null }));
		}

		expect(await corruptOutboxRecords(USER_B)).toEqual([]);
		expect((await accountOutboxSnapshot(USER_B)).corrupt).toEqual([]);
		expect(await discardCorruptOutboxRecord(USER_B, forged)).toBe(false);
		expect(await discardCorruptOutboxRecord(USER_B, invalid)).toBe(false);
		expect(await enqueue(mutation('b-last'), USER_B)).not.toBeNull();
		expect((await deviceOutboxDiagnostics()).filter((d) => d.kind === 'unknown_owner').map((d) => d.key).sort()).toEqual([forged, invalid].sort());
		expect(raw.map.has(forged)).toBe(true);
	});

	it('a corrupt record whose owner record names another account stays out of this account and out of the device bucket', async () => {
		const id = await enqueue(mutation('B'), USER_B) as string;
		raw.map.set(id, 'not json');

		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([]);
		expect(quarantineKeys(raw)).toEqual([]);
		expect((await corruptOutboxRecords(USER_B)).map((r) => r.key)).toEqual([id]);
	});

	it('an unreadable owner record makes a corrupt record unavailable, not unknown-owner', async () => {
		const aId = await enqueue(mutation('A'), USER_A) as string;
		const bId = await enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		raw.map.set(aId, 'not json');
		const realGet = raw.get.bind(raw);
		raw.get = async (k) => { if (k === `owner|${aId}`) throw new Error('disk read error'); return realGet(k); };

		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		expect(await deviceOutboxDiagnostics()).toEqual([{ kind: 'unavailable', key: aId, message: 'stored record could not be read: storage unavailable' }]);
		expect((await blockedDependentIssues(USER_A))[0]).toMatchObject({ entry: { id: bId }, blockers: [{ id: aId, status: 'unavailable' }] });
		expect(quarantineKeys(raw)).toEqual([]);
	});

	it.each([
		['missing', () => undefined],
		['damaged', () => 'garbage'],
		['naming another account', () => JSON.stringify({ userHash: USER_B })],
	])('a valid entry repairs a %s owner record, so later damage is still attributed', async (_name, ownerValue) => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		const value = ownerValue();
		if (value === undefined) raw.map.delete(`owner|${id}`);
		else raw.map.set(`owner|${id}`, value);

		await pendingEntries(USER_A);
		expect(JSON.parse(raw.map.get(`owner|${id}`) as string)).toEqual({ userHash: USER_A });

		raw.map.set(id, 'not json');
		expect((await corruptOutboxRecords(USER_A)).map((r) => r.key)).toEqual([id]);
	});
});

describe('lifecycle fields must describe one state', () => {
	beforeEach(() => _setStorageForTests(raw));

	type Contradiction = [name: string, fields: Record<string, unknown>, reason: string];
	const contradictions: Contradiction[] = [
		['pending with reconciledAt', { reconciledAt: 1 }, 'status pending cannot carry reconciledAt'],
		['pending with acceptedAt', { acceptedAt: 1 }, 'status pending cannot carry acceptedAt'],
		['pending with serverAcceptedAt', { serverAcceptedAt: 1 }, 'status pending cannot carry serverAcceptedAt'],
		['pending with quarantinedAt', { quarantinedAt: 1 }, 'status pending cannot carry quarantinedAt'],
		['pending with discardedAt', { discardedAt: 1 }, 'status pending cannot carry discardedAt'],
		['explicit pending with reconciledAt', { status: 'pending', reconciledAt: 1 }, 'status pending cannot carry reconciledAt'],
		['quarantined with nextAttemptAt', { status: 'quarantined', quarantinedAt: 1, nextAttemptAt: 1 }, 'status quarantined cannot carry nextAttemptAt'],
		['quarantined with reconciledAt', { status: 'quarantined', quarantinedAt: 1, reconciledAt: 1 }, 'status quarantined cannot carry reconciledAt'],
		['quarantined with acceptedAt', { status: 'quarantined', quarantinedAt: 1, acceptedAt: 1 }, 'status quarantined cannot carry acceptedAt'],
		['server-accepted with nextAttemptAt', { status: 'server_accepted_pending_reconcile', serverAcceptedAt: 1, nextAttemptAt: 1 }, 'status server_accepted_pending_reconcile cannot carry nextAttemptAt'],
		['server-accepted with acceptedAt', { status: 'server_accepted_pending_reconcile', serverAcceptedAt: 1, acceptedAt: 1 }, 'status server_accepted_pending_reconcile cannot carry acceptedAt'],
		['server-accepted with quarantinedAt', { status: 'server_accepted_pending_reconcile', serverAcceptedAt: 1, quarantinedAt: 1 }, 'status server_accepted_pending_reconcile cannot carry quarantinedAt'],
		['accepted with reconciledAt', { status: 'accepted', acceptedAt: 1, reconciledAt: 1, mutations: [] }, 'status accepted cannot carry reconciledAt'],
		['accepted with serverAcceptedAt', { status: 'accepted', acceptedAt: 1, serverAcceptedAt: 1, mutations: [] }, 'status accepted cannot carry serverAcceptedAt'],
		['accepted with discardedAt', { status: 'accepted', acceptedAt: 1, discardedAt: 1, mutations: [] }, 'status accepted cannot carry discardedAt'],
		['accepted still carrying mutations', { status: 'accepted', acceptedAt: 1 }, 'status accepted still carries mutations'],
		['discarded with acceptedAt', { status: 'discarded', discardedAt: 1, acceptedAt: 1, mutations: [] }, 'status discarded cannot carry acceptedAt'],
		['discarded with nextAttemptAt', { status: 'discarded', discardedAt: 1, nextAttemptAt: 1, mutations: [] }, 'status discarded cannot carry nextAttemptAt'],
		['discarded still carrying mutations', { status: 'discarded', discardedAt: 1 }, 'status discarded still carries mutations'],
	];

	it.each(contradictions)('%s is quarantined, never replayed', async (_name, fields, reason) => {
		const id = await enqueue(mutation('bad'), USER_A) as string;
		rewriteEntry(raw, id, (e) => Object.assign(e, fields));

		expect((await readyEntries(USER_A)).map((e) => e.id)).not.toContain(id);
		expect(await corruptOutboxRecords(USER_A)).toEqual([expect.objectContaining({ key: id, message: `decoded value is not a valid outbox entry: ${reason}` })]);
	});

	const immediateOutcome = async (id: string) => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			return await Promise.race([
				awaitEntryOutcome(id, USER_A),
				new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
			]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	};

	it('no persisted record is reported accepted and returned by readyEntries at the same time', async () => {
		const shapes: Record<string, unknown>[] = [
			{}, { nextAttemptAt: 1 }, { status: 'pending' },
			{ status: 'server_accepted_pending_reconcile', serverAcceptedAt: 1 },
			{ status: 'server_accepted_pending_reconcile', serverAcceptedAt: 1, reconciledAt: 1 },
			{ status: 'quarantined', quarantinedAt: 1 },
			{ status: 'accepted', acceptedAt: 1, mutations: [] },
			{ status: 'discarded', discardedAt: 1, mutations: [] },
			...contradictions.map(([, fields]) => fields),
		];
		const ids: string[] = [];
		for (const fields of shapes) {
			const id = await enqueue(mutation(`s${ids.length}`), USER_A) as string;
			rewriteEntry(raw, id, (e) => Object.assign(e, fields));
			ids.push(id);
		}

		const ready = new Set((await readyEntries(USER_A)).map((e) => e.id));
		for (const id of ids) {
			const outcome = await immediateOutcome(id);
			const accepted = typeof outcome === 'object' && outcome.kind === 'accepted';
			expect(accepted && ready.has(id), `${id} is both accepted and ready`).toBe(false);
		}
		expect(ready.size).toBeGreaterThan(0); // the valid pending shapes are still replayed
	});

	it('the writers leave no contradictory field behind across retry → quarantine → requeue → accept', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		await recordFailure(id, new IngestError('ingest HTTP 503', { permanent: false, status: 503 }));
		await recordFailure(id, new IngestError('rejected', { permanent: true }));
		await recordFailure(id, new IngestError('ingest HTTP 503', { permanent: false, status: 503 }));
		expect((await quarantinedEntries(USER_A)).map((e) => e.id)).toEqual([id]);
		await requeueEntry(id);
		await recordFailure(id, new IngestError('ingest HTTP 503', { permanent: false, status: 503 }));
		await markServerAccepted(id);

		expect(await corruptOutboxRecords(USER_A)).toEqual([]);
		const stored = JSON.parse(raw.map.get(id) as string);
		expect(stored.status).toBe('server_accepted_pending_reconcile');
		expect(stored).not.toHaveProperty('nextAttemptAt');
		expect(stored).not.toHaveProperty('quarantinedAt');
	});
});

describe('discard is refused when the evidence changed after it was diagnosed', () => {
	beforeEach(() => _setStorageForTests(raw));

	it('account discard: changed bytes are kept, re-diagnosed, and the call fails', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		raw.map.set(id, 'not json');
		const [diagnosed] = await corruptOutboxRecords(USER_A);
		raw.map.set(id, 'different damage');

		expect(await discardCorruptOutboxRecord(USER_A, id)).toBe(false);

		expect(raw.map.get(id)).toBe('different damage');
		const [now] = await corruptOutboxRecords(USER_A);
		expect(now.raw).toBe('different damage');
		expect(now.rawSha256).not.toBe(diagnosed.rawSha256);
		expect(quarantineKeys(raw)).toEqual([`quarantine|${id}`]);
	});

	it('account discard: bytes that became a valid entry are not replaced by a discarded marker, and the diagnosis is kept', async () => {
		const id = await enqueue(mutation('A'), USER_A) as string;
		const valid = raw.map.get(id) as string;
		raw.map.set(id, 'not json');
		await corruptOutboxRecords(USER_A);
		raw.map.set(id, valid);

		expect(await discardCorruptOutboxRecord(USER_A, id)).toBe(false);

		expect(raw.map.get(id)).toBe(valid);
		expect(quarantineKeys(raw)).toEqual([`quarantine|${id}`]);
		expect((await pendingEntries(USER_A)).map((e) => e.id)).toEqual([id]);
	});

	it('device discard: changed bytes are kept, re-diagnosed, and the call fails', async () => {
		const id = '000000001-0000-noow';
		raw.map.set(id, 'not json');
		const [diagnosed] = await deviceOutboxDiagnostics();
		raw.map.set(id, '{"still":');

		expect(await discardUnknownOwnerOutboxRecord(id)).toBe(false);

		expect(raw.map.get(id)).toBe('{"still":');
		const [now] = await deviceOutboxDiagnostics();
		expect(now).toMatchObject({ kind: 'unknown_owner', key: id });
		expect((now as { rawSha256: string }).rawSha256).not.toBe((diagnosed as { rawSha256: string }).rawSha256);
	});
});

class FakeLockManager {
	requested: string[] = [];
	private tails = new Map<string, Promise<void>>();

	request<T>(name: string, optionsOrCallback: unknown, maybeCallback?: (lock: unknown) => T | Promise<T>): Promise<T> {
		const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (lock: unknown) => T | Promise<T>;
		const options = (typeof optionsOrCallback === 'function' ? {} : optionsOrCallback) as { ifAvailable?: boolean };
		this.requested.push(name);
		if (options.ifAvailable && this.tails.has(name)) return Promise.resolve(callback(null));
		const previous = this.tails.get(name) ?? Promise.resolve();
		const run = previous.then(() => callback({ name }));
		const tail: Promise<void> = run.then(() => {}, () => {}).then(() => {
			if (this.tails.get(name) === tail) this.tails.delete(name);
		});
		this.tails.set(name, tail);
		return run;
	}
}

type OutboxModule = typeof import('@/lib/data/outbox');
type Tab = OutboxModule & { secureStore: typeof import('@/lib/data/secureStore') };

const openTab = async (): Promise<Tab> => {
	vi.resetModules();
	const outbox = await import('@/lib/data/outbox');
	const secureStore = await import('@/lib/data/secureStore');
	return { ...outbox, secureStore };
};

describe('cross-tab: quarantine serialization and leader takeover (simulated Web Locks)', () => {
	let locks: FakeLockManager;

	beforeEach(() => {
		locks = new FakeLockManager();
		vi.stubGlobal('navigator', { locks });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('two tabs detecting the same record at once write one diagnosis, serialized by the record lock', async () => {
		const tabA = await openTab();
		const tabB = await openTab();
		const slow: StringStore = {
			...raw,
			get: async (k) => {
				if (k.startsWith('quarantine|')) await new Promise((r) => setTimeout(r, 5));
				return raw.get(k);
			},
		};
		tabA._setStorageForTests(slow);
		tabB._setStorageForTests(slow);
		const id = await tabA.enqueue(mutation('A'), USER_A) as string;
		raw.map.set(id, 'not json');
		raw.writes.length = 0;

		const [a, b] = await Promise.all([tabA.corruptOutboxRecords(USER_A), tabB.corruptOutboxRecords(USER_A)]);

		expect(locks.requested.filter((n) => n === `buckitup-outbox-quarantine:${id}`)).toHaveLength(2);
		expect(raw.writes.filter((k) => k === `quarantine|${id}`)).toHaveLength(1);
		expect(a[0].detectedAt).toBe(b[0].detectedAt);
	});

	it('after the leader tab closes, a reloaded tab takes over: the quarantine and its attribution survive, nothing corrupt is sent', async () => {
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		const useKey = (tab: Tab) => tab._setStorageForTests(tab.secureStore.createSecureStore(raw, { getKey: async () => key }), raw);

		const becomeLeader = async (tab: Tab) => {
			tab.startLeaderElection(USER_A, () => {});
			await vi.waitFor(() => expect(tab.isLeader()).toBe(true));
		};

		const tabA = await openTab();
		useKey(tabA);
		await becomeLeader(tabA);
		const aId = await tabA.enqueue(mutation('A'), USER_A) as string;
		const bId = await tabA.enqueue(mutation('B'), USER_A, { dependsOn: [aId] }) as string;
		await tabA.enqueue(mutation('C'), USER_A);
		const value = raw.map.get(aId) as string;
		raw.map.set(aId, value.slice(0, -6) + (value.at(-6) === 'A' ? 'B' : 'A') + value.slice(-5));
		const [diagnosed] = await tabA.corruptOutboxRecords(USER_A);

		const contender = await openTab();
		useKey(contender);
		contender.startLeaderElection(USER_A, () => {});
		await new Promise((r) => setTimeout(r, 0));
		expect(contender.isLeader()).toBe(false);
		contender.stopLeaderElection();

		tabA.stopLeaderElection();
		await new Promise((r) => setTimeout(r, 0));

		const tabB = await openTab();
		useKey(tabB);
		await becomeLeader(tabB);
		raw.writes.length = 0;
		const sent: unknown[][] = [];
		const result = await tabB.drainOutbox(USER_A, async (m) => { sent.push(m); });

		expect(result.wasLeader).toBe(true);
		expect(sentIds(sent)).toEqual(['dmsg_C']);
		expect((await tabB.blockedEntries(USER_A)).map((e) => e.id)).toEqual([bId]);
		expect(await tabB.corruptOutboxRecords(USER_A)).toEqual([diagnosed]);
		expect(raw.writes.filter((k) => k.startsWith('quarantine|'))).toEqual([]);
		tabB.stopLeaderElection();
	});
});
