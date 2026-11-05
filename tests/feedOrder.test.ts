import { describe, it, expect } from 'vitest';
import { v7 } from 'uuid';
import { compareFeedOrder, feedOrderKey } from '@/lib/data/feedOrder';

// uuidv7 with a chosen ms timestamp: first 12 hex digits are the ms.
const idAt = (ms: number) => {
	const hex = ms.toString(16).padStart(12, '0');
	return `dmsg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
};

describe('feed order', () => {
	it('reads the authoring moment out of the UUIDv7', () => {
		expect(feedOrderKey(idAt(1788500000000), 0)).toBe(1788500000000);
	});

	// The bug this fixes: an edit raises owner_timestamp (it must — the
	// server rejects a stale revision), and sorting by it teleported the
	// edited message to the end of the feed.
	it('keeps an edited message in its place however its revision timestamp grows', () => {
		const earlier = { id: idAt(1000000), ts: 999999999 }; // edited much later
		const later = { id: idAt(2000000), ts: 2000 };
		expect(feedOrderKey(earlier.id, earlier.ts)).toBeLessThan(feedOrderKey(later.id, later.ts));
	});

	it('falls back to the row timestamp for non-dmsg ids', () => {
		expect(feedOrderKey('opt_x', 1700)).toBe(1700000);
		expect(feedOrderKey(undefined, 1700)).toBe(1700000);
	});

	it('orders a fallback entry against uuid entries on the same scale', () => {
		// an optimistic row stamped at second 2000 sits between ms 1_999_000 and 2_001_000
		expect(feedOrderKey('opt_x', 2000)).toBeGreaterThan(feedOrderKey(idAt(1999000), 0));
		expect(feedOrderKey('opt_x', 2000)).toBeLessThan(feedOrderKey(idAt(2001000), 0));
	});

	// Two sends inside one millisecond share the key. Sorting by the key alone
	// left them in whatever order the feed's sources listed them, and that
	// order shifts while placeholders are replaced by their echoes.
	it('orders two messages written in the same millisecond as they were written', () => {
		const [first, second] = [0, 1].map((seq) => 'dmsg_' + v7({ msecs: 1788500000000, seq }));
		expect(feedOrderKey(first, 0)).toBe(feedOrderKey(second, 0));
		const rows = [{ id: second }, { id: first }];
		expect(rows.sort((a, b) => compareFeedOrder(a.id, 0, b.id, 0)).map((r) => r.id)).toEqual([first, second]);
	});

	it('treats an entry as equal to itself', () => {
		expect(compareFeedOrder(idAt(1000), 0, idAt(1000), 0)).toBe(0);
	});

	it('leaves a tie that is not between two dmsg_ ids to the input order', () => {
		expect(compareFeedOrder('opt_msg_10', 5, 'opt_msg_9', 5)).toBe(0);
		expect(compareFeedOrder(idAt(5000), 0, 'opt_x', 5)).toBe(0);
		expect(compareFeedOrder(undefined, 5, '', 5)).toBe(0);
		expect(compareFeedOrder('', 5, undefined, 5)).toBe(0);
	});
});
