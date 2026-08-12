import { describe, it, expect, beforeEach } from 'vitest';
import {
	enqueue,
	pendingEntries,
	drainOutbox,
	_setStorageForTests,
} from '@/lib/data/outbox';
import { createSecureStore, deriveLocalStorageKey, type StringStore } from '@/lib/data/secureStore';

// Raw store standing in for IndexedDB — this is what ends up on disk.
const makeRaw = (): StringStore & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const USER_A = 'u_' + 'a'.repeat(128);
const USER_B = 'u_' + 'b'.repeat(128);
const DIALOG = 'di_' + 'd'.repeat(128);

const mutation = () => ({
	type: 'insert',
	modified: { dialog_hash: DIALOG, message_id: 'msg-1' },
	syncMetadata: { relation: 'dialog_messages' },
});

let raw: ReturnType<typeof makeRaw>;

/** Install the encrypted queue for one account over the shared raw store. */
const useAccount = async (seed: number) => {
	const key = await deriveLocalStorageKey(new Uint8Array(32).fill(seed));
	_setStorageForTests(createSecureStore(raw, { getKey: async () => key }), raw);
};

beforeEach(() => { raw = makeRaw(); });

describe('encrypted outbox', () => {
	it('leaves nothing readable on disk', async () => {
		await useAccount(1);
		await enqueue([mutation()], USER_A);

		const onDisk = [...raw.map.values()].join('');
		expect(onDisk).not.toContain(USER_A);
		expect(onDisk).not.toContain(DIALOG);
		expect(onDisk).not.toContain('msg-1');
		expect(onDisk).not.toContain('dialog_messages');
	});

	it('round-trips a queued entry for its own account', async () => {
		await useAccount(1);
		await enqueue([mutation()], USER_A);

		const entries = await pendingEntries(USER_A);
		expect(entries).toHaveLength(1);
		expect(entries[0].userHash).toBe(USER_A);
		expect(entries[0].mutations).toEqual([mutation()]);
	});

	// The hazard this whole design exists for: before encryption, an unreadable
	// record meant a corrupt one and was deleted. Another account's entries are
	// now unreadable too, and deleting them would destroy their pending writes.
	it('never deletes or returns another account\'s entries', async () => {
		await useAccount(2);
		await enqueue([mutation()], USER_B);
		expect(raw.map.size).toBe(1);

		await useAccount(1);
		await enqueue([mutation()], USER_A);

		const mine = await pendingEntries(USER_A);
		expect(mine).toHaveLength(1);
		expect(mine[0].userHash).toBe(USER_A);

		// B's record is untouched, and still B's when B comes back.
		expect(raw.map.size).toBe(2);
		await useAccount(2);
		const theirs = await pendingEntries(USER_B);
		expect(theirs).toHaveLength(1);
		expect(theirs[0].userHash).toBe(USER_B);
	});

	it('does not drain another account\'s entries', async () => {
		await useAccount(2);
		await enqueue([mutation()], USER_B);

		await useAccount(1);
		const sent: unknown[][] = [];
		const result = await drainOutbox(USER_A, async (m) => { sent.push(m); });

		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
		expect(raw.map.size).toBe(1);
	});

	it('deletes a record that decrypts but is not a valid entry', async () => {
		await useAccount(1);
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		await createSecureStore(raw, { getKey: async () => key }).set('bad', 'not json');

		expect(await pendingEntries(USER_A)).toHaveLength(0);
		expect(raw.map.has('bad')).toBe(false);
	});
});

describe('migration of pre-encryption entries', () => {
	const legacyEntry = (userHash: string) => JSON.stringify({
		id: '000000001-0000',
		userHash,
		relation: 'dialog_messages',
		mutations: [mutation()],
		createdAt: 1,
		attempts: 0,
		lastError: null,
	});

	it('reads a plaintext entry and rewrites it encrypted', async () => {
		raw.map.set('000000001-0000', legacyEntry(USER_A));
		await useAccount(1);

		const entries = await pendingEntries(USER_A);
		expect(entries).toHaveLength(1);
		expect(entries[0].relation).toBe('dialog_messages');

		// Same record, no longer readable.
		const stored = raw.map.get('000000001-0000') as string;
		expect(stored.startsWith('{')).toBe(false);
		expect(stored).not.toContain(USER_A);
	});

	it('leaves a plaintext entry of another account alone', async () => {
		raw.map.set('000000001-0000', legacyEntry(USER_B));
		await useAccount(1);

		expect(await pendingEntries(USER_A)).toHaveLength(0);
		// Still there for B to migrate on its next login.
		expect(raw.map.get('000000001-0000')).toBe(legacyEntry(USER_B));
	});

	it('drains a migrated entry exactly once', async () => {
		raw.map.set('000000001-0000', legacyEntry(USER_A));
		await useAccount(1);

		const sent: unknown[][] = [];
		const first = await drainOutbox(USER_A, async (m) => { sent.push(m); });
		expect(first.sent).toBe(1);

		const second = await drainOutbox(USER_A, async (m) => { sent.push(m); });
		expect(second.sent).toBe(0);
		expect(sent).toHaveLength(1);
		expect(raw.map.size).toBe(0);
	});
});
