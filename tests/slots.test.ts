import { describe, it, expect, vi } from 'vitest';
import { createSlotResolver, SlotMapError, type RootRecord } from '@/lib/data/slots';

/** In-memory stand-in for the encrypted root record. */
const store = (initial: RootRecord | null = null) => {
	let root = initial;
	return {
		access: {
			read: async () => (root ? structuredClone(root) : null),
			write: async (next: RootRecord) => {
				root = structuredClone(next);
			},
		},
		peek: () => root,
		/** Simulates another tab committing a slot behind our back. */
		injectSlot: (name: string, uuid: string) => {
			root = { ...(root ?? {}), slots: { ...(root?.slots ?? {}), [name]: uuid } };
		},
	};
};

describe('slot resolver', () => {
	it('reports a slot that was never created as absent', async () => {
		const r = createSlotResolver(store().access);
		expect(await r.getSlotUuid('contacts')).toBe(null);
	});

	it('creates a slot once and returns the same address afterwards', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const first = await r.ensureSlotUuid('contacts', () => 'uuid-a');
		const second = await r.ensureSlotUuid('contacts', () => 'uuid-b');
		expect(first).toEqual({ uuid: 'uuid-a', created: true });
		expect(second).toEqual({ uuid: 'uuid-a', created: false });
		expect(s.peek()?.slots).toEqual({ contacts: 'uuid-a' });
	});

	// Two callers racing must not end up addressing two different rows: the
	// slot is created once and both get that address.
	it('creates one slot for two concurrent callers', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const mint = vi.fn(() => `uuid-${mint.mock.calls.length}`);
		const [a, b] = await Promise.all([
			r.ensureSlotUuid('contacts', mint),
			r.ensureSlotUuid('contacts', mint),
		]);
		expect(a.uuid).toBe(b.uuid);
		expect(mint).toHaveBeenCalledTimes(1);
		expect(Object.keys(s.peek()?.slots ?? {})).toEqual(['contacts']);
	});

	// A second tab is a separate process, so in-process serialization cannot
	// see it. The loser must adopt the winner's address and surface its own
	// row as orphaned rather than keep writing to a row nobody else reads.
	it('adopts another writeruuid and reports its own as orphaned', async () => {
		const s = store();
		const r = createSlotResolver(s.access);
		const originalWrite = s.access.write;
		s.access.write = async (next: RootRecord) => {
			await originalWrite(next);
			s.injectSlot('contacts', 'uuid-from-other-tab');
		};
		const res = await r.ensureSlotUuid('contacts', () => 'uuid-mine');
		expect(res.uuid).toBe('uuid-from-other-tab');
		expect(res.created).toBe(false);
		expect(res.orphaned).toBe('uuid-mine');
		expect(await r.getSlotUuid('contacts')).toBe('uuid-from-other-tab');
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
		await r.ensureSlotUuid('contacts', () => 'uuid-a');
		// the profile fields survive the map write
		expect(s.peek()).toMatchObject({ name: 'Alice', avatarUuid: 'av-1', slots: { contacts: 'uuid-a' } });
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
