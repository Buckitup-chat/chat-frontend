// @vitest-environment jsdom
//
// A download that finds the file deleted by its uploader, through the chat
// page: the row does not offer a retry of a download that cannot succeed,
// and the manifest read again says the file is deleted, which is what the
// row and the keep switch go by.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';

const HOLDER = vi.hoisted(() => ({ user: null }));
const PEER = 'u_' + 'b'.repeat(128);
const ME = 'u_' + 'a'.repeat(128);

const emptyCollection = () => ({
	rows: new Map(),
	async preload() {},
	get() { return undefined; },
	get toArray() { return []; },
	subscribeChanges() { return { unsubscribe() {} }; },
});
const dialog = { keys: emptyCollection(), messages: emptyCollection(), versions: emptyCollection(), reactions: emptyCollection(), receipts: emptyCollection() };

vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { address: PEER }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: ME, contacts: [], getUserByHash: () => null });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => emptyCollection(),
	getDialogCollections: () => dialog,
	withDialogCollections: async (_hash, read) => read(dialog),
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => ({}) }) },
}));

const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
const { useDialogsStore } = await import('@/store/dialogs.store');
const { FileDeletedError } = await import('@/lib/data/fileTransfer');
const { fileKey } = await import('@/lib/data/fileKey');

const part = {
	kind: 'file', fileId: 'f_' + '1'.repeat(32), uploaderHash: PEER, encSecretB64: 'c2VjcmV0',
	name: 'report.pdf', size: 1024, mimeType: 'application/pdf', createdAt: 1_800_000_000,
};
const key = fileKey(part);

describe('downloading a file its uploader deleted', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('leaves no failed download to retry, and the manifest read again marks the file deleted', async () => {
		const dialogs = useDialogsStore();
		// The page's other work finds no unlocked account here, and says so.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrapper = mount(PageChat, {
			global: {
				provide: { $swal: { fire: async () => ({}) } },
				stubs: { ChatWindow: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
			},
		});
		try {
			let answer;
			const reread = new Promise((resolve) => { answer = resolve; });
			const fetchFile = vi.spyOn(dialogs, 'fetchFile').mockRejectedValue(new FileDeletedError(part.fileId));
			const availability = vi.spyOn(dialogs, 'getFileAvailability').mockReturnValue(reread);
			const chat = wrapper.findComponent({ name: 'ChatWindow' });

			chat.vm.$emit('download-file', part);
			await flushPromises();
			expect(fetchFile).toHaveBeenCalledTimes(1);
			expect(chat.props('downloads')[key]?.status).toBeUndefined();
			expect(availability).toHaveBeenCalledWith(part);

			answer({ present: 0, total: 1, unknown: false, deleted: true });
			await flushPromises();
			expect(chat.props('availability')[key]).toEqual({ present: 0, total: 1, unknown: false, deleted: true });
			expect(chat.props('downloads')[key]?.status).toBeUndefined();
		} finally {
			wrapper.unmount();
			await flushPromises();
			vi.restoreAllMocks();
		}
	});
});
