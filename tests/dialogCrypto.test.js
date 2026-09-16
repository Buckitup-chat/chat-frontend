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

describe('DialogCrypto.computeReceiptHash', () => {
    const MSG = 'dmsg_' + 'a'.repeat(128);
    const V1 = 'dms_' + 'b'.repeat(128);
    const V2 = 'dms_' + 'c'.repeat(128);
    const PEER = 'u_' + 'd'.repeat(128);

    it('matches the domain the server enforces', () => {
        const h = DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read');
        expect(h).toMatch(/^dmrc_[a-f0-9]{128}$/);
    });

    it('is deterministic, so re-confirming cannot create a duplicate row', () => {
        expect(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read'))
            .toBe(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read'));
    });

    it('binds to one message revision — an edit needs its own receipt', () => {
        expect(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read'))
            .not.toBe(DialogCrypto.computeReceiptHash(MSG, V2, PEER, 'read'));
    });

    it('separates delivered from read', () => {
        expect(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read'))
            .not.toBe(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'delivered'));
    });

    it('separates peers', () => {
        const other = 'u_' + 'e'.repeat(128);
        expect(DialogCrypto.computeReceiptHash(MSG, V1, PEER, 'read'))
            .not.toBe(DialogCrypto.computeReceiptHash(MSG, V1, other, 'read'));
    });
});
