import { describe, it, expect } from 'vitest';
import { DialogCrypto } from '@/libs/DialogCrypto';

describe('DialogCrypto.computeDialogHash', () => {
	it('is symmetric: same hash regardless of argument order', () => {
		const a = 'uh_alice';
		const b = 'uh_bob';
		expect(DialogCrypto.computeDialogHash(a, b)).toBe(DialogCrypto.computeDialogHash(b, a));
	});

	it('produces the di_ prefix and a 128-char sha3-512 hex body', () => {
		const hash = DialogCrypto.computeDialogHash('uh_alice', 'uh_bob');
		expect(hash).toMatch(/^di_[0-9a-f]{128}$/);
	});

	it('differs for different user pairs', () => {
		const ab = DialogCrypto.computeDialogHash('uh_alice', 'uh_bob');
		const ac = DialogCrypto.computeDialogHash('uh_alice', 'uh_carol');
		expect(ab).not.toBe(ac);
	});

	it('is deterministic (stable across calls)', () => {
		const first = DialogCrypto.computeDialogHash('uh_x', 'uh_y');
		const second = DialogCrypto.computeDialogHash('uh_x', 'uh_y');
		expect(first).toBe(second);
	});
});
