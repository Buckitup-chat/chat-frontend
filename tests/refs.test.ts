import { describe, it, expect } from 'vitest';
import { computeTails } from '../src/lib/data/refs';

// Scenarios straight from the spec (chat docs: pq_dialogs.md §References,
// §Special cases). Message rows carry their current revision plus the
// decrypted refs of that revision.
const row = (message_id: string, sign_hash: string, refs: Record<string, string> = {}) => ({
	message_id,
	sign_hash,
	refs,
});

describe('computeTails', () => {
	it('genesis: empty dialog has no tails', () => {
		expect(computeTails([])).toEqual({});
	});

	it('first message is the single tail', () => {
		expect(computeTails([row('m1', 's1')])).toEqual({ m1: 's1' });
	});

	it('linear conversation: only the latest message is the tail', () => {
		const tails = computeTails([
			row('m1', 's1'),
			row('m2', 's2', { m1: 's1' }),
			row('m3', 's3', { m2: 's2' }),
		]);
		expect(tails).toEqual({ m3: 's3' });
	});

	it('concurrent fork: both fork tips are tails', () => {
		// both parties replied to m1 without seeing each other
		const tails = computeTails([
			row('m1', 's1'),
			row('a1', 'sa', { m1: 's1' }),
			row('b1', 'sb', { m1: 's1' }),
		]);
		expect(tails).toEqual({ a1: 'sa', b1: 'sb' });
	});

	it('fork merge: a message referencing both tips becomes the only tail', () => {
		const tails = computeTails([
			row('m1', 's1'),
			row('a1', 'sa', { m1: 's1' }),
			row('b1', 'sb', { m1: 's1' }),
			row('m2', 's2', { a1: 'sa', b1: 'sb' }),
		]);
		expect(tails).toEqual({ m2: 's2' });
	});

	it('offline burst: transitive reduction keeps one tail', () => {
		// 50 messages in a chain — only the last one is a tail
		const loaded = [row('m0', 's0')];
		for (let i = 1; i < 50; i++) {
			loaded.push(row(`m${i}`, `s${i}`, { [`m${i - 1}`]: `s${i - 1}` }));
		}
		expect(computeTails(loaded)).toEqual({ m49: 's49' });
	});

	it('edit turns the edited message into a new tail', () => {
		// m1 was referenced by m2 at revision s1; the edit bumped it to s1x —
		// the new pair is unreferenced, so the edited revision is a tail again
		const tails = computeTails([
			row('m1', 's1x'),
			row('m2', 's2', { m1: 's1' }),
		]);
		expect(tails).toEqual({ m1: 's1x', m2: 's2' });
	});

	it('rows without sign_hash (not yet server-confirmed) are skipped', () => {
		const tails = computeTails([
			row('m1', 's1'),
			{ message_id: 'pending', sign_hash: '', refs: {} },
		]);
		expect(tails).toEqual({ m1: 's1' });
	});
});
