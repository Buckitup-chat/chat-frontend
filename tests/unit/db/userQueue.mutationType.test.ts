import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { resolvePendingRecord, buildMutation } from '@/utils/db/tanstack/userQueue';
import { assertReady, changesOf } from '../testHelpers';

const { secretKey: signSkey } = ml_dsa87.keygen();

const fullCard = {
	user_hash: 'u_alice',
	sign_pkey: btoa('sign-pkey'),
	contact_pkey: btoa('contact-pkey'),
	contact_cert: btoa('contact-cert'),
	crypt_pkey: btoa('crypt-pkey'),
	crypt_cert: btoa('crypt-cert'),
	name: 'Alice',
	deleted_flag: false,
	owner_timestamp: 1700000000,
};

describe('resolvePendingRecord — mutation type (user_cards)', () => {
	it('a brand new user (no base row anywhere) resolves to insert', () => {
		const resolved = assertReady(resolvePendingRecord('user_cards', fullCard, { known: true, value: undefined }));
		expect(resolved.mutationType).toBe('insert');
		expect(resolved.record.user_hash).toBe('u_alice');
	});

	it('editing an existing user (base row present) resolves to update, not insert', () => {
		const base = { ...fullCard };
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const resolved = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: base }));
		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.name).toBe('Alice Renamed');
		expect(resolved.record.sign_pkey).toBe(base.sign_pkey);
	});

	it('a tombstone (deleted_flag: true) of an existing user is an update, not an insert', () => {
		const base = { ...fullCard };
		const patch = { user_hash: 'u_alice', deleted_flag: true };
		const resolved = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: base }));
		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.deleted_flag).toBe(true);
	});
});

describe('buildMutation — wire shape follows the resolved mutation type', () => {
	it('insert sends `modified`, no `original`', () => {
		const resolved = assertReady(resolvePendingRecord('user_cards', fullCard, { known: true, value: undefined }));
		const { mutation } = buildMutation('user_cards', resolved.record, resolved.mutationType, signSkey);
		expect(mutation.type).toBe('insert');
		expect(mutation.modified).toBeTruthy();
		expect(mutation.original).toBeUndefined();
	});

	it('update sends `original` + `changes`, not `modified`', () => {
		const base = { ...fullCard };
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const resolved = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: base }));
		const { mutation } = buildMutation('user_cards', resolved.record, resolved.mutationType, signSkey);
		expect(mutation.type).toBe('update');
		expect(mutation.original).toEqual({ user_hash: 'u_alice' });
		expect(changesOf(mutation).name).toBe('Alice Renamed');
		expect(mutation.modified).toBeUndefined();
	});
});

describe('resolvePendingRecord — mutation type (user_storage)', () => {
	const baseStorage = {
		user_hash: 'u_alice',
		uuid: 'profile',
		version: 3,
		value_b64: 'ciphertext-v3',
		hash_b64: 'hash-v3',
		deleted_flag: false,
	};

	it('first-ever write for a (user_hash, uuid) resolves to insert', () => {
		const patch = { user_hash: 'u_alice', uuid: 'profile', value_b64: 'ciphertext-v1' };
		const resolved = assertReady(resolvePendingRecord('user_storage', patch, { known: true, value: undefined }));
		expect(resolved.mutationType).toBe('insert');
	});

	it('a later write to an existing storage row resolves to update', () => {
		const patch = { user_hash: 'u_alice', uuid: 'profile', value_b64: 'ciphertext-v4' };
		const resolved = assertReady(resolvePendingRecord('user_storage', patch, { known: true, value: baseStorage }));
		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.value_b64).toBe('ciphertext-v4');
	});

	it('buildMutation for a storage update omits `modified`', () => {
		const patch = { user_hash: 'u_alice', uuid: 'profile', value_b64: 'ciphertext-v4' };
		const resolved = assertReady(resolvePendingRecord('user_storage', patch, { known: true, value: baseStorage }));
		const { mutation } = buildMutation('user_storage', resolved.record, resolved.mutationType, signSkey);
		expect(mutation.type).toBe('update');
		expect(mutation.original).toEqual({ user_hash: 'u_alice', uuid: 'profile' });
		expect(mutation.modified).toBeUndefined();
	});
});
