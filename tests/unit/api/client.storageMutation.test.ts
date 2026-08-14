import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { api } from '@/api/client';
import type { ApiMutation } from '@/api/client';
import { modifiedOf, changesOf } from '../testHelpers';

const { secretKey: signSkey } = ml_dsa87.keygen();
const TEST_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const USER_STORAGE_SIGN_HASH_RE = /^uss_[0-9a-f]{128}$/;

function expectedSignHash(signB64: string): string {
	const decoded = Uint8Array.from(atob(signB64), (c) => c.charCodeAt(0));
	return 'uss_' + bytesToHex(sha3_512(decoded));
}

interface BuildInsertOptions {
	signHash?: string | null;
	existingSignB64?: string | null;
}

function buildInsert({ signHash = null, existingSignB64 = null }: BuildInsertOptions = {}): ApiMutation {
	return api.createStorageMutation(
		'u_alice',
		TEST_UUID,
		'ciphertext-b64',
		'hash-b64',
		1700000000,
		signSkey,
		false,
		false,
		null,
		signHash,
		existingSignB64,
		'insert'
	);
}

describe('api.createStorageMutation — sign_hash (section P2)', () => {
	it('4: generates a fresh, non-empty sign_hash when signing', () => {
		const mutation = buildInsert();
		expect(modifiedOf(mutation).sign_hash).toBeTruthy();
		expect(typeof modifiedOf(mutation).sign_hash).toBe('string');
	});

	it('5: sign_hash matches the independently-recomputed hash of the actual sign_b64 (not a snapshot)', () => {
		const mutation = buildInsert();
		expect(modifiedOf(mutation).sign_hash).toBe(expectedSignHash(modifiedOf(mutation).sign_b64 as string));
	});

	it('ignores a caller-supplied signHash entirely — it is never authoritative', () => {
		const staleSignHash = 'dms_stale-caller-value-that-must-be-discarded';
		const mutation = buildInsert({ signHash: staleSignHash });
		expect(modifiedOf(mutation).sign_hash).not.toBe(staleSignHash);
		expect(modifiedOf(mutation).sign_hash).toBe(expectedSignHash(modifiedOf(mutation).sign_b64 as string));
	});

	it('rederives sign_hash to match an existing sign_b64 too (not just a freshly-generated one)', () => {
		const existingSignBytes = ml_dsa87.sign(new TextEncoder().encode('some-prior-signed-payload'), signSkey);
		const existingSignB64 = btoa(String.fromCharCode(...existingSignBytes));
		const mutation = buildInsert({ existingSignB64 });

		expect(modifiedOf(mutation).sign_b64).toBe(existingSignB64);
		expect(modifiedOf(mutation).sign_hash).toBe(expectedSignHash(existingSignB64));
	});

	it('1: emits exactly "uss_" + 128 lowercase hex chars — the confirmed accepted backend format', () => {
		const mutation = buildInsert();
		expect(modifiedOf(mutation).sign_hash).toMatch(USER_STORAGE_SIGN_HASH_RE);
	});

	it('1 (update): the "uss_" format holds for update mutations too', () => {
		const mutation = api.createStorageMutation('u_alice', TEST_UUID, 'v', 'h', 1700000000, signSkey, false, false, null, null, null, 'update');
		expect(changesOf(mutation).sign_hash).toMatch(USER_STORAGE_SIGN_HASH_RE);
	});

	it('2: never emits the dialog_*-relation "dms_" prefix for user_storage', () => {
		const mutation = buildInsert();
		expect((modifiedOf(mutation).sign_hash as string).startsWith('dms_')).toBe(false);
	});
});

describe('api.createGenericMutation — dialog_* sign_hash prefix is unaffected (section 5)', () => {
	it('still emits "dms_" + 128 lowercase hex chars, unchanged by the user_storage-specific fix', () => {
		const mutation = api.createGenericMutation(
			'dialog_messages',
			{ message_id: 'm1', dialog_hash: 'd1', sender_hash: 's1', content_b64: 'content' },
			signSkey,
			'insert'
		);
		expect(modifiedOf(mutation).sign_hash).toMatch(/^dms_[0-9a-f]{128}$/);
	});
});

describe('api.createStorageMutation — version (section P3)', () => {
	it('10: version is never included in the transmitted mutation, matching the confirmed backend contract', () => {
		// `createStorageMutation` no longer even accepts a `version` argument
		// (confirmed against a live 422 response that the backend doesn't
		// validate it) — this guards the resulting shape regardless.
		const mutation = buildInsert();
		expect(modifiedOf(mutation).version).toBeUndefined();
		expect(Object.keys(modifiedOf(mutation))).not.toContain('version');
	});

	it('an update mutation also never includes version in `changes`', () => {
		const mutation = api.createStorageMutation('u_alice', TEST_UUID, 'v', 'h', 1700000000, signSkey, false, false, null, null, null, 'update');
		expect(changesOf(mutation).version).toBeUndefined();
		expect(Object.keys(changesOf(mutation))).not.toContain('version');
	});
});
