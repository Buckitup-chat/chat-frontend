import { describe, it, expect } from 'vitest';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { bytesToHex } from '@noble/hashes/utils';

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

describe('DialogCrypto.deriveSenderMsgKey', () => {
    const SIGN_SKEY = Uint8Array.from({ length: 4896 }, (_, i) => i % 251);
    const CRYPT_SKEY = Uint8Array.from({ length: 3168 }, (_, i) => (7 * i + 3) % 256);
    const PEER_HASH = 'u_' + '0123456789abcdef'.repeat(8);
    const KEY_HEX = '263b9313b65516a3b5e8a6dcd51ee553690c4cf5db7080ed1742f002773e12a2';

    const flipFirst = (bytes) => {
        const copy = bytes.slice();
        copy[0] ^= 1;
        return copy;
    };

    it('IKM is sign_skey || crypt_skey || UTF8(peer_user_hash)', () => {
        expect(bytesToHex(DialogCrypto.deriveSenderMsgKey(SIGN_SKEY, CRYPT_SKEY, PEER_HASH))).toBe(KEY_HEX);
    });

    it('changes when any input changes', () => {
        const variants = [
            [flipFirst(SIGN_SKEY), CRYPT_SKEY, PEER_HASH],
            [SIGN_SKEY, flipFirst(CRYPT_SKEY), PEER_HASH],
            [SIGN_SKEY, CRYPT_SKEY, PEER_HASH + '0'],
        ];
        for (const [sign, crypt, peer] of variants) {
            expect(bytesToHex(DialogCrypto.deriveSenderMsgKey(sign, crypt, peer))).not.toBe(KEY_HEX);
        }
    });
});
