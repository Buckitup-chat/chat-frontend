import { describe, it, expect } from 'vitest';
import { feedOrderKey } from '@/lib/data/feedOrder';

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
});
