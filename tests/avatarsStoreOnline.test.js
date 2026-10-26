// @vitest-environment jsdom
// The grant dialogs are owed goes out when the connection comes back.
import { describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const MAPPING = { galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: 'K'.repeat(42) + 'w', generation: 1 };
const user = reactive({ currentUserHash: ME, currentUser: { user_hash: ME, avatar: null, avatarId: null }, contactsMap: {} });
const sent = [];
const dialogs = {
	onOwnSend: () => {},
	ownDialogCarriesGrant: async () => {
		const carries = sent.some((s) => s.peer === PEER);
		return { carries, confirmed: carries };
	},
	sendMessage: async (peer, parts) => { sent.push({ peer, parts }); },
	readPeerParts: async () => null,
};
let online = false;
let initialCalls = 0;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/lib/data/outboundDialogs', () => ({ peersWeWrote: async () => [PEER] }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async () => null,
			publishInitialSharedGallery: async () => {
				initialCalls++;
				return online ? { state: 'published', mapping: MAPPING } : { state: 'pending', reason: 'row', detail: 'read_failed' };
			},
		}),
	},
}));
vi.mock('@/utils/imageResize', () => ({ resizeImageUrl: async () => ({ dataUrl: 'x' }) }));

const { useAvatarsStore } = await import('@/store/avatars.store');
const { useMemoryAvatarStore } = await import('./helpers/avatarLocalStore');
const { loadGranted } = await import('@/lib/avatars/localStore');

describe('the grant on reconnect', () => {
	it('is sent once the connection is back, though the last try was moments ago', async () => {
		useMemoryAvatarStore();
		setActivePinia(createPinia());
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		useAvatarsStore();
		await vi.waitFor(() => expect(initialCalls).toBe(1));
		expect(sent).toEqual([]);
		online = true;
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => expect(sent.map((s) => s.peer)).toEqual([PEER]));
		expect(sent[0].parts[0]).toMatchObject({ kind: 'avatar_gallery_access', galleryUuid: MAPPING.galleryUuid });
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(async () => expect(await loadGranted(ME)).toEqual({ [PEER]: MAPPING.galleryUuid }));
		expect(sent).toHaveLength(1);
		warn.mockRestore();
	});
});
