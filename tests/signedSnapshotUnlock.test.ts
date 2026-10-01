import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const USER = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);
const SKEY = new Uint8Array(32).fill(3);
const DIALOG = 'di_' + '1'.repeat(128);

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };
const tagOf = (m: Mutation) => String((m.modified ?? m.changes)?.tag);

const http = { bodies: [] as string[], tags: [] as string[], authLock: null as null | (() => Error) };
vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			if (http.authLock) throw http.authLock();
			http.bodies.push(JSON.stringify(mutations));
			http.tags.push(tagOf(mutations[0]));
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 900 + index })) }) } as unknown as Response;
		},
	},
}));

const ingest = await import('@/lib/data/ingest');
const outbox = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests, getAccepted } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { createSecureStore } = await import('@/lib/data/secureStore');
const { VaultLockedError, AccountMismatchError } = await import('@/lib/data/keyCustody');

const makeRaw = () => {
	const map = new Map<string, string>();
	return {
		map,
		failGet: null as null | ((k: string) => Error | null),
		async get(k: string) { const e = this.failGet?.(k); if (e) throw e; return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};
const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

let raw: ReturnType<typeof makeRaw>;
let accountKey: CryptoKey;
let storeLocked: boolean;
let keyLocked: 'no' | 'locked' | 'other-account';
let keyReads: number;
const signingKey = async () => {
	keyReads++;
	if (keyLocked === 'locked') throw new VaultLockedError('the vault is locked');
	if (keyLocked === 'other-account') throw new AccountMismatchError('another account is open');
	return SKEY;
};
let acceptedLocked: boolean;

const receipt = (tag: string): Mutation[] => [{
	type: 'insert',
	modified: { receipt_hash: `dmrc_${tag}`, peer_hash: USER, dialog_hash: DIALOG, tag, sign_b64: `signature-of-${tag}` },
	syncMetadata: { relation: 'dialog_message_receipts' },
}];
const edit = (tag: string): Mutation[] => [{
	type: 'update', original: {},
	changes: { message_id: 'dmsg_X', sender_hash: USER, dialog_hash: DIALOG, tag, sign_b64: `signature-of-${tag}` },
	syncMetadata: { relation: 'dialog_messages' },
}];

const rawSnapshot = () => JSON.stringify([...raw.map.entries()].sort());
const entryOf = async (id: string) => JSON.parse((await createSecureStore(raw, { getKey: async () => accountKey }).get(id))!);
const drainMicrotasks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const pass = async () => {
	ingest.drainPendingWrites(USER, signingKey);
	await drainMicrotasks();
	await outbox._drainLoopSettledForTests();
	await drainMicrotasks();
};

beforeEach(async () => {
	http.bodies = [];
	http.tags = [];
	http.authLock = null;
	storeLocked = false;
	keyLocked = 'no';
	keyReads = 0;
	acceptedLocked = false;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	raw = makeRaw();
	accountKey = await newKey();
	const secure = createSecureStore(raw, {
		getKey: async () => {
			if (storeLocked) throw new VaultLockedError('[localCrypto] no unlocked account: local storage is not readable yet');
			return accountKey;
		},
	});
	outbox._setStorageForTests(secure, raw);
	const accepted = makeRaw();
	_setAcceptedSnapshotStorageForTests({
		...accepted,
		get: async (k: string) => { if (acceptedLocked) throw new VaultLockedError('locked'); return accepted.map.get(k) ?? null; },
		set: async (k: string, v: string) => { if (acceptedLocked) throw new VaultLockedError('locked'); accepted.map.set(k, v); },
	});
	_setOwnObservedTailsStorageForTests(makeRaw());
	outbox.startLeaderElection(USER, () => {});
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
});

afterEach(async () => {
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('locked before the scan: the ciphertext cannot be opened', () => {
	it('no request, and not a byte of the outbox changes — however many passes', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		expect((await entryOf(id)).mutations).toEqual(receipt('A'));
		const before = rawSnapshot();

		storeLocked = true;
		await pass();
		await pass();
		await pass();

		expect(http.bodies).toEqual([]);
		expect(rawSnapshot()).toBe(before); // no attempt, no schedule, no quarantine record
	});

	it('after the unlock, the next pass sends that same entry, byte for byte', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		const stored = JSON.stringify((await entryOf(id)).mutations);
		storeLocked = true;
		await pass();

		storeLocked = false;
		await pass();
		expect(http.bodies).toEqual([stored]);
		expect((await entryOf(id)).status).toBe('accepted');
	});
});

describe('locked after the read: the request cannot be authenticated', () => {
	it('no request, no attempt, no schedule, no failure recorded — however many passes', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		const before = rawSnapshot();

		keyLocked = 'locked';
		await pass();
		await pass();

		expect(http.bodies).toEqual([]);
		const entry = await entryOf(id);
		expect(entry).toMatchObject({ attempts: 0, lastError: null });
		expect(entry).not.toHaveProperty('nextAttemptAt');
		expect(entry).not.toHaveProperty('lastErrorNetwork');
		expect(rawSnapshot()).toBe(before);
	});

	it('after the unlock the same outboxId goes, with the stored signature and bytes', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		const stored = JSON.stringify((await entryOf(id)).mutations);
		keyLocked = 'locked';
		await pass();

		keyLocked = 'no';
		await pass();
		expect(http.bodies).toEqual([stored]);
		expect(JSON.parse(http.bodies[0])[0].modified.sign_b64).toBe('signature-of-A');
		expect((await entryOf(id)).status).toBe('accepted');
	});

	it('a lock met inside request authentication is the same non-attempt, not a network failure', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		const stored = JSON.stringify((await entryOf(id)).mutations);
		const before = rawSnapshot();

		http.authLock = () => new VaultLockedError('key custody is locked');
		await pass();
		await pass();
		expect(http.bodies).toEqual([]);
		expect(rawSnapshot()).toBe(before);

		http.authLock = () => new AccountMismatchError('another account is open');
		await pass();
		expect(rawSnapshot()).toBe(before);

		http.authLock = null;
		await pass();
		expect(http.bodies).toEqual([stored]);
	});

	it('a live write met by a locked key is stored, reported locked, and left for the unlock', async () => {
		keyLocked = 'locked';
		const error = await ingest.sendMutationsAndAwaitShape(receipt('L'), signingKey).then(() => null, (e) => e);
		expect(error).toBeInstanceOf(VaultLockedError);
		expect(http.bodies).toEqual([]);
		const [id] = [...raw.map.keys()].filter((k) => !k.includes('|'));
		expect(await entryOf(id)).toMatchObject({ attempts: 0 });
		expect(await entryOf(id)).not.toHaveProperty('nextAttemptAt');
	});

	it('it waits without a timer: no polling while locked', async () => {
		await outbox.enqueue(receipt('A'), USER);
		keyLocked = 'locked';
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		await pass();
		const readsAfterPass = keyReads;
		expect(readsAfterPass).toBeGreaterThan(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(keyReads).toBe(readsAfterPass);
		expect(http.bodies).toEqual([]);
	});
});

describe('what the entry carries is kept through the lock', () => {
	it('dependencies, a held entry and a future retry time are as they were after the unlock', async () => {
		const a = (await outbox.enqueue(edit('A'), USER))!;
		const b = (await outbox.enqueue(edit('B'), USER, { dependsOn: [a] }))!;
		const held = (await outbox.enqueue(receipt('H'), USER, {
			discoveryBlocked: outbox.dependencyBlockFor(null, { kind: 'discovery', observedKeys: null }),
		}))!;
		const later = (await outbox.enqueue(receipt('L'), USER))!;
		await outbox.recordFailure(later, new ingest.IngestError('503', { permanent: false }));
		const records = async () => Promise.all([a, b, held, later].map(entryOf));
		const before = await records();

		storeLocked = true;
		await pass();
		expect(await records()).toEqual(before);

		keyLocked = 'locked';
		storeLocked = false;
		await pass();
		const discoveryAttemptsOf = (r: { discoveryBlocked?: { attempts: number } }) => r.discoveryBlocked?.attempts;
		const withoutDiscoveryCount = (rs: Record<string, unknown>[]) =>
			rs.map((r) => (r.discoveryBlocked ? { ...r, discoveryBlocked: { ...(r.discoveryBlocked as object), attempts: 'n' } } : r));
		const underKeyLock = await records();
		expect(withoutDiscoveryCount(underKeyLock)).toEqual(withoutDiscoveryCount(before));
		expect(discoveryAttemptsOf(underKeyLock[2])).toBe(discoveryAttemptsOf(before[2])! + 1);

		keyLocked = 'no';
		await pass();
		expect(http.tags).toEqual(['A', 'B']);
		expect((await entryOf(later)).nextAttemptAt).toBe(before[3].nextAttemptAt);
		expect((await entryOf(held)).discoveryBlocked).toMatchObject({ kind: 'discovery', reason: 'boundary_unknown', observedKeys: null, blockedAt: before[2].discoveryBlocked.blockedAt });
		expect((await entryOf(b)).status).toBe('accepted');
		expect(before[1].dependsOn).toEqual([a]);
		expect(http.bodies[1]).toBe(JSON.stringify(before[1].mutations));
	});
});

describe('another account, and what is not a lock', () => {
	it('an entry of A is not sent under B\'s session', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		outbox.stopLeaderElection();
		outbox.startLeaderElection(OTHER, () => {});
		ingest.drainPendingWrites(OTHER, signingKey);
		ingest.drainPendingWrites(USER, signingKey);
		await drainMicrotasks();
		await outbox._drainLoopSettledForTests();
		expect(http.bodies).toEqual([]);
		expect((await entryOf(id)).attempts).toBe(0);
	});

	it('AccountMismatchError is neither a network failure nor a lock of the other account: nothing recorded', async () => {
		const id = (await outbox.enqueue(receipt('A'), USER))!;
		const before = rawSnapshot();
		keyLocked = 'other-account';
		await pass();
		expect(http.bodies).toEqual([]);
		expect(rawSnapshot()).toBe(before);
		expect(await entryOf(id)).not.toHaveProperty('lastErrorNetwork');
	});

	it('corrupt, foreign and unreadable records keep their own handling; a lock quarantines nothing', async () => {
		const damaged = (await outbox.enqueue(receipt('D'), USER))!;
		const unreadable = (await outbox.enqueue(receipt('U'), USER))!;
		raw.map.set(damaged, raw.map.get(damaged)!.slice(0, -6) + 'AAAAAA');
		const otherKey = await newKey();
		const theirs = createSecureStore(raw, { getKey: async () => otherKey });
		await theirs.set('owner|0000-theirs', JSON.stringify({ userHash: OTHER }));
		await theirs.set('0000-theirs', JSON.stringify({ id: '0000-theirs', userHash: OTHER }));
		raw.failGet = (k) => (k === unreadable ? new Error('disk read error') : null);

		storeLocked = true;
		await pass();
		expect([...raw.map.keys()].filter((k) => k.startsWith('quarantine|'))).toEqual([]);

		storeLocked = false;
		const corrupt = await outbox.corruptOutboxRecords(USER);
		expect(corrupt.map((r) => r.key)).toEqual([damaged]);
		expect(raw.map.has('quarantine|0000-theirs')).toBe(false);
		expect(raw.map.has(`quarantine|${unreadable}`)).toBe(false);
		expect(http.bodies).toEqual([]);
	});
});

describe('accepted by the server, reconciliation met by a lock', () => {
	it('no second request; after the unlock the reconciliation finishes', async () => {
		acceptedLocked = true;
		const handle = await ingest.sendMutationsAndAwaitShape(receipt('R'), signingKey);
		expect(handle.phase).toBe('accepted');
		expect((await entryOf(handle.outboxId!)).status).toBe('server_accepted_pending_reconcile');

		await pass();
		expect(http.bodies).toHaveLength(1);

		acceptedLocked = false;
		await pass();
		expect(http.bodies).toHaveLength(1);
		expect((await entryOf(handle.outboxId!)).status).toBe('accepted');
		expect(await getAccepted('dialog_message_receipts', 'dmrc_R', USER)).toMatchObject({ receipt_hash: 'dmrc_R' });
	});
});

describe('the session hands the sender a key reader, never the key', () => {
	const em = readFileSync(join(process.cwd(), 'src/libs/EncryptionManagerPQ.js'), 'utf8');
	const between = (from: string, to: string) => em.slice(em.indexOf(from), em.indexOf(to, em.indexOf(from)));

	it('every sender trigger of the session gets the reader, bound to its account', () => {
		const drain = between('#startOutboxDrain() {', '#stopOutboxDrain() {');
		expect(drain).toMatch(/const signSkey = this\.#signingKeyOf\(userHash\);/);
		expect(drain.match(/(drain|resume)PendingWrites\(userHash, signSkey\)/g)).toHaveLength(5);
		expect(drain).not.toMatch(/PendingWrites\([^)]*this\.#signSkey/);
	});

	it('the reader is locked unless this account\'s key is open now', () => {
		const reader = between('#signingKeyOf(userHash) {', '#recoverIntents(userHash) {');
		expect(reader).toMatch(/this\.#currentUserHash !== userHash \|\| !\(this\.#signSkey instanceof Uint8Array\)/);
		expect(reader).toMatch(/throw new VaultLockedError\(/);
		expect(reader).toMatch(/return this\.#signSkey;/); // read at call time, not captured
	});
});
