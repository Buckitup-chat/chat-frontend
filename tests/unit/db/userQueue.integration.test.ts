import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { assertReady, changesOf } from '../testHelpers';

const fullCard = {
	user_hash: 'u_alice',
	sign_pkey: btoa('sign-pkey'),
	contact_pkey: btoa('contact-pkey'),
	contact_cert: btoa('contact-cert'),
	crypt_pkey: btoa('crypt-pkey'),
	crypt_cert: btoa('crypt-cert'),
	name: 'Alice',
	deleted_flag: false,
};

async function freshQueue() {
	vi.resetModules();
	return import('@/utils/db/tanstack/userQueue');
}

describe('userQueue integration — multiple pending writes do not lose earlier fields (section 9)', () => {
	it('a full new-user write followed by a partial {user_hash, name} edit keeps every required field, latest name wins', async () => {
		const q = await freshQueue();

		await q.putPendingUserCard(fullCard, fullCard);
		const edited = { ...fullCard, name: 'Alice Renamed' };
		const entry = await q.putPendingUserCard(edited, { user_hash: 'u_alice', name: 'Alice Renamed' });

		expect(entry.patch.sign_pkey).toBe(fullCard.sign_pkey);
		expect(entry.patch.contact_pkey).toBe(fullCard.contact_pkey);
		expect(entry.patch.crypt_pkey).toBe(fullCard.crypt_pkey);
		expect(entry.patch.name).toBe('Alice Renamed');
		expect(entry.revision).toBe(2);
	});

	it('three successive partial edits to different fields all survive together', async () => {
		const q = await freshQueue();

		await q.putPendingUserCard({ user_hash: 'u_bob', name: 'Bob' }, { user_hash: 'u_bob', name: 'Bob' });
		await q.putPendingUserCard(
			{ user_hash: 'u_bob', name: 'Bob', sign_pkey: 'sp' },
			{ user_hash: 'u_bob', sign_pkey: 'sp' }
		);
		const entry = await q.putPendingUserCard(
			{ user_hash: 'u_bob', name: 'Bob', sign_pkey: 'sp', crypt_pkey: 'cp' },
			{ user_hash: 'u_bob', crypt_pkey: 'cp' }
		);

		expect(entry.patch).toMatchObject({ user_hash: 'u_bob', name: 'Bob', sign_pkey: 'sp', crypt_pkey: 'cp' });
	});
});

describe('userQueue integration — insert confirmed but not yet echoed by Electric (section 7)', () => {
	it('an edit made after the backend accepted the insert (but before Electric echoes it) resolves as update, not another insert', async () => {
		const q = await freshQueue();
		const inserted = await q.putPendingUserCard(fullCard, fullCard);

		await q.markAwaitingRemote(inserted, fullCard);

		q.setRemoteReaders({
			user_cards: { get: () => undefined, isReady: () => true },
		});

		const edited = { ...fullCard, name: 'Alice Renamed' };
		const secondEntry = await q.putPendingUserCard(edited, { user_hash: 'u_alice', name: 'Alice Renamed' });

		expect(secondEntry.sentSnapshot).toMatchObject({ user_hash: 'u_alice', name: 'Alice' });

		const baseState = q.resolveBaseState('user_cards', 'u_alice');
		expect(baseState).toEqual({ known: true, value: undefined });

		const resolved = assertReady(
			q.resolvePendingRecord('user_cards', secondEntry.patch, baseState, secondEntry.sentSnapshot)
		);

		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.name).toBe('Alice Renamed');

		const { secretKey: signSkey } = ml_dsa87.keygen();
		const { mutation } = q.buildMutation('user_cards', resolved.record, resolved.mutationType, signSkey);
		expect(mutation.type).toBe('update');
		expect(changesOf(mutation).name).toBe('Alice Renamed');
	});

	it('once Electric actually echoes the row, resolution uses that fresher data instead of the stale sentSnapshot', async () => {
		const q = await freshQueue();

		const inserted = await q.putPendingUserCard(fullCard, fullCard);
		await q.markAwaitingRemote(inserted, fullCard);

		q.setRemoteReaders({
			user_cards: { get: () => ({ ...fullCard }), isReady: () => true },
		});

		const edited = { ...fullCard, name: 'Alice Renamed' };
		const secondEntry = await q.putPendingUserCard(edited, { user_hash: 'u_alice', name: 'Alice Renamed' });

		const baseState = q.resolveBaseState('user_cards', 'u_alice');
		expect(baseState.known).toBe(true);
		expect(baseState.value).toMatchObject({ user_hash: 'u_alice' });

		const resolved = assertReady(q.resolvePendingRecord('user_cards', secondEntry.patch, baseState, secondEntry.sentSnapshot));
		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.name).toBe('Alice Renamed');
	});
});
