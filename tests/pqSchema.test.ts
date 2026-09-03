import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { signableFields } from '@/lib/pq/schema';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import { verifyMessageRow } from '@/lib/pq/verifyDialogRow';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

// A row passes through the shape endpoint, a TanStack collection and
// wa-sqlite persistence before it is verified. Each layer may add keys, drop
// nulls, or round-trip a boolean as 0/1 — none of which the signer did.
// Verification therefore builds the payload from a named field list.

describe('signableFields', () => {
	const row = { a: 1, deleted_flag: 0, owner_timestamp: '77', name: 'x' };

	it('takes only the schema fields, ignoring extras the row carries', () => {
		const fields = signableFields('user_cards', {
			user_hash: 'u_a', sign_pkey: 'AA', contact_pkey: 'AA', contact_cert: 'AA',
			crypt_pkey: 'AA', crypt_cert: 'AA', name: 'n', deleted_flag: false, owner_timestamp: 1,
			_persistenceRowId: 42, __synced: true,
		});
		expect(Object.keys(fields!).sort()).toEqual([
			'contact_cert', 'contact_pkey', 'crypt_cert', 'crypt_pkey',
			'deleted_flag', 'name', 'owner_timestamp', 'sign_pkey', 'user_hash',
		]);
	});

	// SQLite has no boolean: a persisted false comes back as 0 and would
	// encode as "0" where the signer wrote "false".
	it('restores booleans that came back as sqlite integers', () => {
		expect(signableFields('dialog_message_reactions', {
			reaction_hash: 'dmr_a', dialog_hash: 'di_a', message_id: 'm', message_sign_hash: 'dms_a',
			reactor_hash: 'u_a', type_b64: 'AA', deleted_flag: 0, owner_timestamp: 1,
		})!.deleted_flag).toBe(false);
		expect(signableFields('dialog_message_reactions', {
			reaction_hash: 'dmr_a', dialog_hash: 'di_a', message_id: 'm', message_sign_hash: 'dms_a',
			reactor_hash: 'u_a', type_b64: 'AA', deleted_flag: 1, owner_timestamp: 1,
		})!.deleted_flag).toBe(true);
	});

	it('restores integers that came back as text', () => {
		expect(signableFields('user_cards', {
			user_hash: 'u_a', sign_pkey: 'AA', contact_pkey: 'AA', contact_cert: 'AA',
			crypt_pkey: 'AA', crypt_cert: 'AA', name: 'n', deleted_flag: false, owner_timestamp: '1788467407',
		})!.owner_timestamp).toBe(1788467407);
	});

	it('refuses a row missing a signed column rather than guessing', () => {
		expect(signableFields('user_cards', { user_hash: 'u_a' })).toBe(null);
		expect(signableFields('unknown_table', row)).toBe(null);
	});

	it('keeps an explicit null (parent_sign_hash on a first revision)', () => {
		const f = signableFields('dialog_messages', {
			message_id: 'm', dialog_hash: 'di_a', sender_hash: 'u_a', content_b64: 'AA',
			deleted_flag: false, refs_map_b64: 'AA', parent_sign_hash: null, owner_timestamp: 1,
		});
		expect(f!.parent_sign_hash).toBe(null);
	});
});

describe('verification survives the persistence round trip', () => {
	const keys = ml_dsa87.keygen(new Uint8Array(32).fill(21));
	const userHash = 'u_' + bytesToHex(sha3_512(keys.publicKey));
	const kem = new Uint8Array(64).fill(3);
	const card: Record<string, unknown> = {
		user_hash: userHash,
		sign_pkey: toBase64(keys.publicKey),
		contact_pkey: toBase64(new Uint8Array([1, 2, 3])),
		contact_cert: toBase64(ml_dsa87.sign(new Uint8Array([1, 2, 3]), keys.secretKey)),
		crypt_pkey: toBase64(kem),
		crypt_cert: toBase64(ml_dsa87.sign(kem, keys.secretKey)),
		name: 'арк-конт1',
		deleted_flag: false,
		owner_timestamp: 1788467407,
	};
	card.sign_b64 = signFields(card as never, keys.secretKey);

	it('verifies a card whose booleans and ints came back sqlite-shaped', () => {
		const persisted = { ...card, deleted_flag: 0, owner_timestamp: '1788467407' };
		expect(verifyUserCard(persisted as never).status).toBe('verified');
	});

	it('verifies a card carrying extra bookkeeping keys', () => {
		const withExtras = { ...card, _rowid: 7, __collectionMeta: { synced: true } };
		expect(verifyUserCard(withExtras as never).status).toBe('verified');
	});

	it('still rejects a genuinely tampered card', () => {
		expect(verifyUserCard({ ...card, name: 'Mallory' } as never)).toMatchObject({
			status: 'invalid', reason: 'bad_signature',
		});
	});

	it('verifies a message row that came back sqlite-shaped', () => {
		const fields = {
			message_id: 'dmsg_1', dialog_hash: 'di_' + 'a'.repeat(128), sender_hash: userHash,
			content_b64: toBase64(new Uint8Array([9, 9])), deleted_flag: false,
			refs_map_b64: toBase64(new Uint8Array([8])), parent_sign_hash: null, owner_timestamp: 5,
		};
		const sign_b64 = signFields(fields as never, keys.secretKey);
		const persisted = { ...fields, sign_b64, sign_hash: null, deleted_flag: 0, owner_timestamp: '5', _rowid: 3 };
		expect(verifyMessageRow(persisted as never, toBase64(keys.publicKey))).toEqual({ status: 'ok' });
	});
});
