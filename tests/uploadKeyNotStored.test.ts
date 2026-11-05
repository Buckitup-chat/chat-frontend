// @vitest-environment jsdom
// A file's encryption secret opens its content (docs/invariants.md §1): an
// upload keeps it in memory and never writes it to localStorage.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const MY_HASH = 'u_' + '1'.repeat(128);
const uploaded = vi.hoisted(() => ({ secret: '' }));

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUserHash: MY_HASH }) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => ({ sign_skey: btoa('sign-skey') }) }) },
}));
vi.mock('@/lib/data/fileTransfer', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/data/fileTransfer')>()),
	uploadFile: async (o: { fileId: string; encSecretB64: string; bytes: Uint8Array }) => {
		uploaded.secret = o.encSecretB64;
		return { fileId: o.fileId, encSecretB64: o.encSecretB64, size: o.bytes.length, chunkCount: 1 };
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

beforeEach(() => {
	setActivePinia(createPinia());
	localStorage.clear();
});

describe('uploading a file', () => {
	it('keeps the file secret out of localStorage', async () => {
		const part = await useDialogsStore().uploadAttachment({
			name: 'report.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]),
		});
		expect(part.encSecretB64).toBe(uploaded.secret);
		expect(uploaded.secret).not.toBe('');
		const stored = Object.keys(localStorage).map((k) => k + localStorage.getItem(k)).join('\n');
		expect(stored).not.toContain(uploaded.secret);
		expect(stored).not.toContain('report.pdf');
	});
});
