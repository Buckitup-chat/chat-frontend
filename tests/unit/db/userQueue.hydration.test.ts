import { describe, it, expect } from 'vitest';
import { resolvePendingRecord } from '@/utils/db/tanstack/userQueue';
import { assertReady } from '../testHelpers';

const fullCard = {
	user_hash: 'u_alice',
	sign_pkey: 'sign-pkey-b64',
	contact_pkey: 'contact-pkey-b64',
	contact_cert: 'contact-cert-b64',
	crypt_pkey: 'crypt-pkey-b64',
	crypt_cert: 'crypt-cert-b64',
	name: 'Alice',
	deleted_flag: false,
};

describe('resolvePendingRecord — partial patch before Electric hydration', () => {
	it('stays not-ready (pending) while the collection has not hydrated and nothing is cached', () => {
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const resolved = resolvePendingRecord('user_cards', patch, { known: false, value: undefined });
		expect(resolved.ready).toBe(false);
		expect(resolved).not.toHaveProperty('record');
	});

	it('never invents/defaults the missing required fields to force it through', () => {
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const resolved = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: undefined }));
		expect(resolved.record.sign_pkey).toBeUndefined();
		expect(resolved.record.contact_pkey).toBeUndefined();
		expect(resolved.record.crypt_pkey).toBeUndefined();
	});

	it('once the base becomes available, the SAME patch resolves to a correct, complete update', () => {
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const resolved = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: fullCard }));
		expect(resolved.mutationType).toBe('update');
		expect(resolved.record).toEqual({ ...fullCard, name: 'Alice Renamed' });
	});

	it('does not get permanently stuck: readiness is re-evaluated fresh each call, not cached from the first (not-ready) attempt', () => {
		const patch = { user_hash: 'u_alice', name: 'Alice Renamed' };
		const firstAttempt = resolvePendingRecord('user_cards', patch, { known: false, value: undefined });
		expect(firstAttempt.ready).toBe(false);

		const secondAttempt = assertReady(resolvePendingRecord('user_cards', patch, { known: true, value: fullCard }));
		expect(secondAttempt.record.name).toBe('Alice Renamed');
		expect(secondAttempt.record.sign_pkey).toBe(fullCard.sign_pkey);
	});
});
