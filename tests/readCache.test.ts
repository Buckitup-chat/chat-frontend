import { describe, it, expect, beforeEach } from 'vitest';
import { markTouched, isTouched, mergeLiveWithCached, clearReadCache, _resetTouchedForTests } from '@/lib/data/readCache';

type Row = { message_id: string; content_b64?: string };
const byMessageId = (r: Row) => r.message_id;

beforeEach(() => {
	_resetTouchedForTests();
});

describe('hydration race guard (§3.4 — a disk read must never overwrite live data)', () => {
	it('a key touched by live data is excluded from the cached rows, even if the disk copy exists', () => {
		markTouched('dialog_messages', 'dmsg_1');

		expect(mergeLiveWithCached<Row>('dialog_messages', [], [{ message_id: 'dmsg_1', content_b64: 'stale' }], byMessageId)).toEqual([]);
	});

	it('an untouched key is still served from cache normally', () => {
		expect(mergeLiveWithCached<Row>('dialog_messages', [], [{ message_id: 'dmsg_2' }], byMessageId)).toEqual([{ message_id: 'dmsg_2' }]);
	});

	it('touching one key never excludes a different key of the same table', () => {
		markTouched('dialog_messages', 'a');

		const merged = mergeLiveWithCached<Row>('dialog_messages', [], [{ message_id: 'a' }, { message_id: 'b' }], byMessageId);

		expect(merged).toEqual([{ message_id: 'b' }]);
	});

	it('a live row always wins over a stale cached row with the same key (canonical priority)', () => {
		const merged = mergeLiveWithCached<Row>(
			'dialog_messages',
			[{ message_id: 'a', content_b64: 'fresh' }],
			[{ message_id: 'a', content_b64: 'stale' }],
			byMessageId,
		);

		expect(merged).toEqual([{ message_id: 'a', content_b64: 'fresh' }]);
	});
});

describe('clearReadCache (§3.11 discipline — logout/account switch)', () => {
	it('wipes the touched-keys guard', async () => {
		markTouched('dialog_messages', 'b');

		await clearReadCache();

		expect(isTouched('dialog_messages', 'b')).toBe(false);
	});

	it('keeps the touched keys of the tables it is told to keep', async () => {
		markTouched('user_cards', 'u1');
		markTouched('dialog_messages', 'b');

		await clearReadCache({ keep: ['user_cards'] });

		expect(isTouched('user_cards', 'u1')).toBe(true);
		expect(isTouched('dialog_messages', 'b')).toBe(false);
	});
});
