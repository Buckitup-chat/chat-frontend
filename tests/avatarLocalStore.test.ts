import { describe, it, expect, beforeEach } from 'vitest';
import { getThumb, putThumb, forgetThumb, loadOwed, updateOwed, forgetAccountAvatars } from '@/lib/avatars/localStore';
import { useMemoryAvatarStore } from './helpers/avatarLocalStore';

// What this device keeps about profile photos: sealed per account, one
// thumbnail per contact, gone with the account.

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const PEER = 'u_' + 'c'.repeat(128);
const THUMB = 'data:image/jpeg;base64,/9j/THUMBNAILBYTES';

let raw: Map<string, string>;
beforeEach(() => { raw = useMemoryAvatarStore(); });

describe('avatar local store', () => {
	it('keeps a contact\'s thumbnail sealed: nothing of it is readable on disk', async () => {
		await putThumb(A, PEER, { avatarId: 'f'.repeat(32), thumb: THUMB });
		expect(await getThumb(A, PEER)).toEqual({ avatarId: 'f'.repeat(32), thumb: THUMB });
		const stored = [...raw.values()].join('');
		expect(stored).not.toContain('THUMBNAILBYTES');
		expect(stored).not.toContain('f'.repeat(32));
	});

	it('one thumbnail per contact: a new photo\'s replaces the old one, and forgetting removes it', async () => {
		await putThumb(A, PEER, { avatarId: '1'.repeat(32), thumb: 'old' });
		await putThumb(A, PEER, { avatarId: '2'.repeat(32), thumb: 'new' });
		expect(raw.size).toBe(1);
		expect((await getThumb(A, PEER))?.thumb).toBe('new');
		await forgetThumb(A, PEER);
		expect(await getThumb(A, PEER)).toBeNull();
	});

	it('is per account: another account neither sees nor opens it', async () => {
		await putThumb(A, PEER, { avatarId: '1'.repeat(32), thumb: 'a' });
		expect(await getThumb(B, PEER)).toBeNull();
	});

	it('keeps owed deliveries, merging concurrent updates, and drops settled ones', async () => {
		await Promise.all([
			updateOwed(A, (o) => { o.P1 = { change: true }; }),
			updateOwed(A, (o) => { o.P2 = { first: true }; }),
		]);
		expect(Object.keys(await loadOwed(A)).sort()).toEqual(['P1', 'P2']);
		await updateOwed(A, (o) => { o.P1 = {}; });
		expect(Object.keys(await loadOwed(A))).toEqual(['P2']);
	});

	it('removing an account removes all it kept, and nothing of another account', async () => {
		await putThumb(A, PEER, { avatarId: '1'.repeat(32), thumb: 'a' });
		await updateOwed(A, (o) => { o.P1 = { change: true }; });
		await putThumb(B, PEER, { avatarId: '1'.repeat(32), thumb: 'b' });
		await forgetAccountAvatars(A);
		expect(await getThumb(A, PEER)).toBeNull();
		expect(await loadOwed(A)).toEqual({});
		expect((await getThumb(B, PEER))?.thumb).toBe('b');
	});
});
