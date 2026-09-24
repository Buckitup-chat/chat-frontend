import { describe, it, expect } from 'vitest';
import { presentedRowFingerprint } from '@/lib/pq/verifyDialogRow';

const baseRow = () => ({
	message_id: 'dmsg_' + 'a'.repeat(8) + '-0000-7000-8000-000000000000',
	dialog_hash: 'di_' + 'b'.repeat(128),
	sender_hash: 'u_' + 'c'.repeat(128),
	content_b64: 'AAAA',
	deleted_flag: false,
	refs_map_b64: 'BBBB',
	parent_sign_hash: null,
	owner_timestamp: 1_700_000_000,
	sign_b64: 'sig-bytes-stand-in',
	sign_hash: 'dms_' + 'd'.repeat(128),
});

describe('presentedRowFingerprint: fixed-length, collision-resistant local cache identity', () => {
	it('is a fixed-length hex digest (SHA3-512, 128 hex chars) regardless of input size', () => {
		const small = presentedRowFingerprint(baseRow());
		const huge = presentedRowFingerprint({ ...baseRow(), content_b64: 'A'.repeat(50_000) });

		expect(small).toMatch(/^[0-9a-f]{128}$/);
		expect(huge).toMatch(/^[0-9a-f]{128}$/);
		expect(huge.length).toBe(small.length);
	});

	it('is deterministic for the same input', () => {
		const row = baseRow();
		expect(presentedRowFingerprint(row)).toBe(presentedRowFingerprint({ ...row }));
	});

	it('changes when any signed field changes', () => {
		const row = baseRow();
		const original = presentedRowFingerprint(row);
		for (const [key, tweak] of Object.entries({
			content_b64: 'ZZZZ',
			deleted_flag: true,
			refs_map_b64: 'ZZZZ',
			parent_sign_hash: 'dms_' + 'e'.repeat(128),
			owner_timestamp: row.owner_timestamp + 1,
			dialog_hash: 'di_' + 'f'.repeat(128),
			sender_hash: 'u_' + 'f'.repeat(128),
			message_id: 'dmsg_' + 'f'.repeat(8) + '-0000-7000-8000-000000000000',
		})) {
			const changed = presentedRowFingerprint({ ...row, [key]: tweak });
			expect(changed, `field ${key}`).not.toBe(original);
		}
	});

	it('changes when sign_b64 changes, even though every signed field and the claimed sign_hash stay the same', () => {
		const row = baseRow();
		const original = presentedRowFingerprint(row);
		const resigned = presentedRowFingerprint({ ...row, sign_b64: 'a-different-signature-entirely' });
		expect(resigned).not.toBe(original);
	});

	it('changes when the claimed sign_hash changes, even though every signed field and sign_b64 stay the same', () => {
		const row = baseRow();
		const original = presentedRowFingerprint(row);
		const relabeled = presentedRowFingerprint({ ...row, sign_hash: 'dms_' + '9'.repeat(128) });
		expect(relabeled).not.toBe(original);
	});

	it('does not collide when a delimiter-like character inside sign_b64 shifts into what would be the sign_hash segment', () => {
		const a = presentedRowFingerprint({ ...baseRow(), sign_b64: 'x|y', sign_hash: 'z' });
		const b = presentedRowFingerprint({ ...baseRow(), sign_b64: 'x', sign_hash: 'y|z' });
		expect(a).not.toBe(b);
	});
});
