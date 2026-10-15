// @vitest-environment jsdom
// What dialogs are owed a photo goes out when the connection comes back.
import { describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const user = reactive({ currentUserHash: ME, currentUser: { user_hash: ME, avatar: 'data:x', avatarId: 'a'.repeat(32) }, contactsMap: {} });
const sent = [];
const dialogs = {
	onOwnSend: () => {},
	ownDialogCarriesAvatar: async () => ({ ownKey: true, carries: false }),
	sendMessage: async (peer, parts) => { sent.push({ peer, parts }); },
};
const slot = { avatars: { ['a'.repeat(32)]: { photo: { image: [1, 1, '', 'a.jpg', 1, 'image/jpeg', 0, 'f_1', 'k'] }, at: 1 } } };

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ loadSlotJson: async () => slot }) },
}));
vi.mock('@/utils/imageResize', () => ({ resizeImageUrl: async () => ({ dataUrl: 'x' }) }));

const { useAvatarsStore } = await import('@/store/avatars.store');
const { useMemoryAvatarStore } = await import('./helpers/avatarLocalStore');
const { updateOwed, loadOwed } = await import('@/lib/avatars/localStore');

describe('owed photos on reconnect', () => {
	it('are sent on the online event', async () => {
		useMemoryAvatarStore();
		setActivePinia(createPinia());
		await updateOwed(ME, (o) => { o[PEER] = { first: true }; });
		useAvatarsStore();
		await new Promise((r) => setTimeout(r, 0));
		expect(sent).toEqual([]); // no contacts loaded yet
		user.contactsMap = { [PEER]: { user_hash: PEER } };
		sent.length = 0;
		await vi.waitFor(() => expect(sent.length).toBe(1));
		// owed again, then the connection returns
		await updateOwed(ME, (o) => { o[PEER] = { first: true }; });
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => expect(sent.length).toBe(2));
		await vi.waitFor(async () => expect(await loadOwed(ME)).toEqual({}));
	});
});
