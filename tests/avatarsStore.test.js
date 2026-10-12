// The avatars store wires the gallery to its slot and its dialogs
// (pq_avatars): a change is recorded in the slot, then sent to the
// contacts this account has written to; the first message into a contact's
// dialog brings the whole gallery. Fakes keep the contracts: the slot merges
// patches like storageIntent, a sent message is readable in its dialog.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

const ME = 'u_' + 'a'.repeat(128);
const OTHER_ACCOUNT = 'u_' + 'e'.repeat(128);
const WRITTEN = 'u_' + 'b'.repeat(128); // a contact this account has sent to
const SILENT = 'u_' + 'c'.repeat(128); // a contact it never wrote to
const STRANGER = 'u_' + 'd'.repeat(128);

let user;
let dialogs;
let slot;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async () => slot,
			patchSlotJson: async (_name, patch) => {
				slot = stripPatchDirectives(mergeJsonPatch(slot, patch));
				return slot;
			},
		}),
	},
}));

const { useAvatarsStore } = await import('@/store/avatars.store');

const fakeDialogs = () => {
	const messages = new Map(); // peer -> [{ messageId, senderHash, parts }]
	const listeners = new Set();
	let seq = 0;
	return {
		messages,
		sent: [],
		uploads: 0,
		getDialogHash: (peer) => `di_${peer}`,
		onOwnSend: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		async uploadAttachment({ name, mimeType, bytes }) {
			this.uploads++;
			return {
				kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name, size: bytes.length, mimeType,
				createdAt: 0, fileId: `f_${String(this.uploads).padStart(32, '0')}`, encSecretB64: 'k',
			};
		},
		async sendMessage(peer, parts) {
			this.sent.push({ peer, parts });
			const list = messages.get(peer) ?? [];
			list.push({ messageId: `dmsg_${String(++seq).padStart(4, '0')}`, senderHash: user.currentUserHash, parts });
			messages.set(peer, list);
			for (const fn of listeners) fn(peer, parts);
		},
		async hasOwnDialogKey(peer) { return messages.has(peer); },
		async ownMessagesIn(peer) { return (messages.get(peer) ?? []).filter((m) => m.senderHash === user.currentUserHash); },
		async fetchFile() { return new Uint8Array([1, 2, 3]); },
	};
};

const photoBlob = () => new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const kindsSentTo = (peer) => dialogs.sent.filter((s) => s.peer === peer).map((s) => s.parts.map((p) => p.kind).join('+'));

beforeEach(() => {
	const storage = new Map();
	globalThis.localStorage = {
		getItem: (k) => storage.get(k) ?? null,
		setItem: (k, v) => storage.set(k, String(v)),
		removeItem: (k) => storage.delete(k),
	};
	slot = null;
	user = reactive({
		currentUserHash: ME,
		currentUser: { user_hash: ME },
		contactsMap: { [WRITTEN]: { user_hash: WRITTEN }, [SILENT]: { user_hash: SILENT } },
		async setOwnAvatarImage({ avatarId, dataUrl }) { Object.assign(user.currentUser, { avatarId, avatar: dataUrl }); },
	});
	dialogs = fakeDialogs();
	dialogs.messages.set(WRITTEN, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	dialogs.messages.set(STRANGER, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	setActivePinia(createPinia());
});

describe('avatars store', () => {
	it('adds a photo: one upload, recorded in the slot, the own picture follows, sent to the contacts written to', async () => {
		const store = useAvatarsStore();
		const result = await store.addPhoto(photoBlob());
		expect(dialogs.uploads).toBe(1);
		expect(store.ownGallery).toHaveLength(1);
		expect(user.currentUser.avatarId).toBe(store.ownGallery[0].avatarId);
		expect(user.currentUser.avatar).toBe('data:image/jpeg;base64,CQkJ');
		expect(result.sent).toEqual([WRITTEN]);
		expect(kindsSentTo(SILENT)).toEqual([]);
		expect(kindsSentTo(STRANGER)).toEqual([]);
	});

	it('a second photo goes out as the change alone; every dialog references the same file', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		expect(kindsSentTo(WRITTEN)).toEqual(['avatar', 'avatar']);
		expect(dialogs.uploads).toBe(2);
	});

	it('set as main and remove go out as their one part, and the slot order follows', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		const [newest, oldest] = store.ownGallery.map((e) => e.avatarId);
		await store.setMain(oldest);
		expect(store.ownGallery.map((e) => e.avatarId)).toEqual([oldest, newest]);
		expect(user.currentUser.avatarId).toBe(oldest);
		await store.removePhoto(newest);
		expect(store.ownGallery.map((e) => e.avatarId)).toEqual([oldest]);
		expect(dialogs.sent.slice(-2).map((s) => s.parts)).toEqual([
			[{ kind: 'avatar', avatarId: oldest, photo: expect.objectContaining({ kind: 'image' }) }],
			[{ kind: 'avatar_removed', avatarId: newest }],
		]);
	});

	it('the first message into a contact\'s dialog brings the gallery, once; not into a stranger\'s', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'hello' }]);
		await settle();
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'again' }]);
		await settle();
		expect(kindsSentTo(SILENT)).toEqual(['text', 'avatar+avatar', 'text']);
		await dialogs.sendMessage(STRANGER, [{ kind: 'text', text: 'hello' }]);
		await settle();
		expect(kindsSentTo(STRANGER)).toEqual(['text']);
	});

	it('a delivery still running when the account changes sends nothing from the next one', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		dialogs.sent.length = 0;
		const send = dialogs.sendMessage.bind(dialogs);
		dialogs.hasOwnDialogKey = async (peer) => {
			user.currentUserHash = OTHER_ACCOUNT;
			return dialogs.messages.has(peer);
		};
		dialogs.sendMessage = send;
		const result = await store.setMain(store.ownGallery[0].avatarId);
		expect(dialogs.sent).toEqual([]);
		expect(result.sent).toEqual([]);
		expect(String(result.failed[0]?.error?.message)).toMatch(/account changed/);
	});
});
