import { describe, it, expect, vi } from 'vitest';
import { createSlotResolver, SlotMapError, type RootRecord } from '@/lib/data/slots';

/** In-memory stand-in for the encrypted root record plus the slot rows. */
const store = (initial: RootRecord | null = null) => {
	let root = initial;
	const rows = new Set<string>();
	const events: string[] = [];
	return {
		rows,
		events,
		access: {
			read: async () => (root ? structuredClone(root) : null),
			write: async (next: RootRecord) => {
				const merged: RootRecord = { ...(root ?? {}), ...next };
				if (root?.slots || next.slots) merged.slots = { ...(root?.slots ?? {}), ...(next.slots ?? {}) };
				root = structuredClone(merged);
				events.push(`map:${Object.values(root.slots ?? {}).join(',')}`);
			},
		},
		writeRow: async (uuid: string) => {
			events.push(`row:${uuid}`);
			rows.add(uuid);
		},
		peek: () => root,
		/** Simulates another client committing a slot behind our back. */
		injectSlot: (name: string, uuid: string) => {
			root = { ...(root ?? {}), slots: { ...(root?.slots ?? {}), [name]: uuid } };
		},
	};
};

const opts = (s: ReturnType<typeof store>, mint: () => string) => ({ mint, writeRow: s.writeRow });

describe('slot resolver', () => {
	it('reports a slot that was never created as absent', async () => {
		const r = createSlotResolver(store().access);
		expect(await r.getSlotUuid('contacts')).toBe(null);
	});

	it('creates a slot once and reuses that address on later writes', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const first = await r.ensureSlotUuid('contacts', opts(s, () => 'uuid-a'));
		const second = await r.ensureSlotUuid('contacts', opts(s, () => 'uuid-b'));
		expect(first).toEqual({ uuid: 'uuid-a', created: true });
		expect(second).toEqual({ uuid: 'uuid-a', created: false });
		expect(s.peek()?.slots).toEqual({ contacts: 'uuid-a' });
		expect([...s.rows]).toEqual(['uuid-a']);
	});

	// A map entry naming a row that does not exist is indistinguishable from
	// corruption, and the reader must treat it as an error. Writing the row
	// first means a crash in between leaves an unreferenced row instead.
	it('writes the slot row before the map entry that names it', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		await r.ensureSlotUuid('contacts', opts(s, () => 'uuid-a'));
		expect(s.events).toEqual(['row:uuid-a', 'map:uuid-a']);
	});

	it('leaves no map entry when the slot row fails to write', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const failing = { mint: () => 'uuid-a', writeRow: async () => { throw new Error('offline'); } };
		await expect(r.ensureSlotUuid('contacts', failing)).rejects.toThrow('offline');
		expect(s.peek()?.slots ?? {}).toEqual({});
	});

	// Two callers racing must not end up addressing two different rows.
	it('creates one slot for two concurrent callers', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const mint = vi.fn(() => `uuid-${mint.mock.calls.length}`);
		const [a, b] = await Promise.all([
			r.ensureSlotUuid('contacts', opts(s, mint)),
			r.ensureSlotUuid('contacts', opts(s, mint)),
		]);
		expect(a.uuid).toBe(b.uuid);
		expect(mint).toHaveBeenCalledTimes(1);
		expect(Object.keys(s.peek()?.slots ?? {})).toEqual(['contacts']);
	});

	// Another device is another process, so in-process serialization cannot
	// see it. The loser adopts the winner's address and hands its own row back
	// for the caller to tombstone.
	it('adopts another client uuid and reports its own row as orphaned', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const originalWrite = s.access.write;
		s.access.write = async (next: RootRecord) => {
			await originalWrite(next);
			s.injectSlot('contacts', 'uuid-from-other-device');
		};
		const res = await r.ensureSlotUuid('contacts', opts(s, () => 'uuid-mine'));
		expect(res.uuid).toBe('uuid-from-other-device');
		expect(res.created).toBe(false);
		expect(res.orphaned).toBe('uuid-mine');
		expect(await r.getSlotUuid('contacts')).toBe('uuid-from-other-device');
		// losing the race must not lose the payload: the caller tombstones
		// the orphaned row, so the save only survives if the write was
		// re-issued against the adopted address before returning
		expect(s.events).toContain('row:uuid-from-other-device');
	});

	// Losing the map must not look like "slot never existed": creating a fresh
	// contacts row on top would abandon the user's real contacts.
	it('refuses to invent an address for a slot the map should contain', async () => {
		const r = createSlotResolver(store({ name: 'x' }).access);
		await expect(r.requireSlotUuid('contacts')).rejects.toBeInstanceOf(SlotMapError);
	});

	it('treats a root record with no slots map as a valid empty state', async () => {
		const s = store({ name: 'Alice', avatarUuid: 'av-1' });
		const r = createSlotResolver(s.access);
		expect(await r.getSlotUuid('contacts')).toBe(null);
		await r.ensureSlotUuid('contacts', opts(s, () => 'uuid-a'));
		// the profile fields survive the map write
		expect(s.peek()).toMatchObject({ name: 'Alice', avatarUuid: 'av-1', slots: { contacts: 'uuid-a' } });
	});

	describe('durable slot -> root continuation survives a crash between slot acceptance and the root mapping (v3 §7)', () => {
		it('recovers the already-accepted slot uuid instead of minting a second, orphaning one', async () => {
			const s = store();
			let pendingMint: string | null = null;
			const opts = (mint: () => string) => ({
				mint,
				writeRow: s.writeRow,
				recallPendingMint: async () => pendingMint,
				rememberPendingMint: async (uuid: string) => { pendingMint = uuid; },
				forgetPendingMint: async () => { pendingMint = null; },
			});

			const crashingAccess = {
				read: s.access.read,
				write: async () => { throw new Error('crash before root mapping'); },
			};
			const r1 = createSlotResolver(crashingAccess);
			await expect(r1.ensureSlotUuid('contacts', opts(() => 'uuid-minted-first'))).rejects.toThrow('crash before root mapping');
			expect([...s.rows]).toEqual(['uuid-minted-first']);
			expect(s.peek()?.slots ?? {}).toEqual({});

			const r2 = createSlotResolver(s.access);
			const result = await r2.ensureSlotUuid('contacts', opts(() => 'uuid-minted-SECOND-should-never-be-used'));

			expect(result.uuid).toBe('uuid-minted-first');
			expect([...s.rows]).toEqual(['uuid-minted-first']);
			expect(s.peek()?.slots).toEqual({ contacts: 'uuid-minted-first' });
		});

		it('without a durable pendingMint record, behavior is unchanged (backward compatible)', async () => {
			const s = store();
			const r = createSlotResolver(s.access);
			const first = await r.ensureSlotUuid('contacts', { mint: () => 'uuid-a', writeRow: s.writeRow });
			expect(first).toEqual({ uuid: 'uuid-a', created: true });
		});
	});

	// Cached addresses belong to one account; carrying them past logout would
	// point the next account at a stranger's rows.
	it('drops the cache on reset so another account re-reads its own map', async () => {
		const s = store({ slots: { contacts: 'uuid-first' } });
		const r = createSlotResolver(s.access);
		expect(await r.getSlotUuid('contacts')).toBe('uuid-first');
		s.injectSlot('contacts', 'uuid-second');
		expect(await r.getSlotUuid('contacts')).toBe('uuid-first'); // still cached
		r.reset();
		expect(await r.getSlotUuid('contacts')).toBe('uuid-second');
	});
});
