// @vitest-environment jsdom
// The plaintext file keys earlier builds left in localStorage are removed, and
// nothing else is.
import { describe, it, expect } from 'vitest';
import { forgetPlaintextUploadKeys } from '@/lib/forgetUploadKeys';

describe('forgetPlaintextUploadKeys', () => {
	it('removes every stored upload key and keeps the rest', () => {
		localStorage.setItem('bkp:pending-upload:f_1', JSON.stringify({ encSecretB64: 'AAAA', name: 'a.png', size: 1 }));
		localStorage.setItem('bkp:pending-upload:f_2', '{}');
		localStorage.setItem('buckitup:device-label', 'Laptop');
		forgetPlaintextUploadKeys();
		expect(Object.keys(localStorage)).toEqual(['buckitup:device-label']);
	});
});
