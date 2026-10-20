import { describe, it, expect, beforeEach } from 'vitest';
import {
	getThumb, putThumb, forgetThumb, loadGranted, markGranted, getPeerGrant, putPeerGrant, forgetAccountAvatars,
} from '@/lib/avatars/localStore';
import { useMemoryAvatarStore } from './helpers/avatarLocalStore';

// What this device keeps about profile photos: sealed per account, one
// thumbnail and one grant per contact, gone with the account.

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

	it('keeps a contact\'s grant sealed, one per contact, per account', async () => {
		const KEY = 'K'.repeat(42) + 'w';
		await putPeerGrant(A, PEER, { galleryUuid: 'g1', galleryKeyB64: KEY, messageId: 'dmsg_1' });
		await putPeerGrant(A, PEER, { galleryUuid: 'g1', galleryKeyB64: KEY, messageId: 'dmsg_2' });
		expect(await getPeerGrant(A, PEER)).toEqual({ galleryUuid: 'g1', galleryKeyB64: KEY, messageId: 'dmsg_2' });
		expect([...raw.values()].join('')).not.toContain(KEY);
		expect(await getPeerGrant(B, PEER)).toBeNull();
	});

	it('removing an account removes all it kept, and nothing of another account', async () => {
		await putThumb(A, PEER, { avatarId: '1'.repeat(32), thumb: 'a' });
		await markGranted(A, 'P1', 'g1');
		await putPeerGrant(A, PEER, { galleryUuid: 'g1', galleryKeyB64: 'k', messageId: 'dmsg_1' });
		await putThumb(B, PEER, { avatarId: '1'.repeat(32), thumb: 'b' });
		await forgetAccountAvatars(A);
		expect(await getThumb(A, PEER)).toBeNull();
		expect(await loadGranted(A)).toEqual({});
		expect(await getPeerGrant(A, PEER)).toBeNull();
		expect((await getThumb(B, PEER))?.thumb).toBe('b');
	});
});

