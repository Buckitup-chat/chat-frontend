// A peer's parts read in the background (the owner's backup reading its
// guardians' word on their pieces): only the peer's live rows that pass the
// gate, decrypted with the peer's real wrapped key, through the transient
// bundle — and a delivered receipt only when it verifies against the peer.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, fromBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { makeTestIdentity, signRow } from './helpers/signedFixtures';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

let collections;
let opened;
let registered;
const HOLDER = vi.hoisted(() => ({ user: null, vault: {} }));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '' });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => { registered++; return collections.dialog; },
	withDialogCollections: async (h, read) => { opened.push(h); return read(collections.dialog); },
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => HOLDER.vault }) },
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');
const { encodeContent } = await import('@/lib/pq/content');

const me = makeTestIdentity(21);
const peer = makeTestIdentity(22);
const holding = (state) => ({ kind: 'recovery_holding', secretRef: 'eip155:1:0x1/0x2', version: 1, splitId: 's', shareIndex: 1, state, detail: '' });
const SIGN = 'dms_' + 'ab'.repeat(64);
const id = (n) => `dmsg_0192aaaa-0000-7000-8000-00000000000${n}`;

describe('readPeerParts', () => {
	let store, dialogHash, peerKey, myKey;

	const message = async (author, key, n, parts, tweak = {}) => {
		const fields = {
			message_id: id(n),
			dialog_hash: dialogHash,
			sender_hash: author.userHash,
			content_b64: await DialogCrypto.encryptContent(key, encodeContent(parts)),
			deleted_flag: false,
			refs_map_b64: await DialogCrypto.encryptContent(key, JSON.stringify({})),
			parent_sign_hash: null,
			owner_timestamp: 1_700_000_500 + n,
			...tweak,
		};
		const sign_b64 = signFields(fields, author.signSkey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};
	const seed = (...rows) => { for (const r of rows) collections.dialog.messages.rows.set(r.message_id, r); };
	const receipt = (author, messageId, type, over = {}) => signRow(author, {
		receipt_hash: DialogCrypto.computeReceiptHash(messageId, SIGN, author.userHash, type),
		dialog_hash: dialogHash,
		message_id: messageId,
		peer_hash: author.userHash,
		type,
		message_sign_hash: SIGN,
		owner_timestamp: 1_700_000_900,
		...over,
	});

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		opened = [];
		registered = 0;
		HOLDER.user.currentUserHash = me.userHash;
		HOLDER.vault = me.vault;
		collections = {
			cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card }),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer.userHash);
		// The peer's key, wrapped for this account, as the peer publishes it.
		peerKey = DialogCrypto.deriveSenderMsgKey(peer.signSkey, peer.kemSkey, bytesToHex(peer.contactSk), me.userHash);
		const wrapped = await DialogCrypto.wrapSenderMsgKey(peerKey, fromBase64(me.card.crypt_pkey));
		collections.dialog.keys.rows.set(`${dialogHash}|${peer.userHash}`, signRow(peer, {
			dialog_hash: dialogHash, sender_hash: peer.userHash, peer_hash: me.userHash,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1_700_000_000,
		}));
		myKey = DialogCrypto.deriveSenderMsgKey(me.signSkey, me.kemSkey, bytesToHex(me.contactSk), peer.userHash);
		collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, signRow(me, {
			dialog_hash: dialogHash, sender_hash: me.userHash, peer_hash: peer.userHash,
			peer_kem_wrap_key_b64: 'AQ', peer_wrapped_msg_key_b64: 'Ag', deleted_flag: false, owner_timestamp: 1_700_000_000,
		}));
	});

	it('returns the peer\'s parts of the kinds asked, oldest first, from verified live rows only', async () => {
		const forged = await message(peer, peerKey, 4, [holding('given_back')]);
		seed(
			await message(peer, peerKey, 1, [{ kind: 'text', text: 'hi' }, holding('stored')]),
			await message(me, myKey, 2, [holding('dropped')]),
			await message(peer, peerKey, 3, [], { deleted_flag: true, content_b64: '' }),
			{ ...forged, sign_b64: forged.sign_b64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) },
			await message(peer, peerKey, 5, [holding('unverified')]),
			await message(peer, peerKey, 6, [{ kind: 'text', text: 'bye' }]),
		);

		const read = await store.readPeerParts(peer.userHash, ['recovery_holding']);
		expect(read.messages).toEqual([
			{ messageId: id(1), senderHash: peer.userHash, parts: [holding('stored')] },
			{ messageId: id(5), senderHash: peer.userHash, parts: [holding('unverified')] },
		]);
		expect(read.delivered).toEqual([]);
		expect(opened).toEqual([dialogHash]);
		expect(registered).toBe(0);
	});

	it('with newestMatch, returns only the newest message with a part it accepts', async () => {
		seed(
			await message(peer, peerKey, 1, [holding('stored')]),
			await message(peer, peerKey, 5, [holding('unverified')]),
			await message(peer, peerKey, 6, [{ kind: 'text', text: 'bye' }]),
		);
		const newest = await store.readPeerParts(peer.userHash, ['recovery_holding'], { newestMatch: () => true });
		expect(newest.messages).toEqual([{ messageId: id(5), senderHash: peer.userHash, parts: [holding('unverified')] }]);
		const stored = await store.readPeerParts(peer.userHash, ['recovery_holding'], { newestMatch: (p) => p.state === 'stored' });
		expect(stored.messages.map((m) => m.messageId)).toEqual([id(1)]);
	});

	it('with after, leaves out what the peer wrote before that message', async () => {
		// Ids carry their authoring time (UUIDv7): these three were written in this order.
		const at = (ms) => `dmsg_0192aa${ms}0-0000-7000-8000-000000000000`;
		seed(
			await message(peer, peerKey, 1, [holding('given_back')], { message_id: at(1) }),
			await message(me, myKey, 3, [{ kind: 'text', text: 'the share' }], { message_id: at(3) }),
		);
		expect((await store.readPeerParts(peer.userHash, ['recovery_holding'], { newestMatch: () => true, after: at(3) })).messages).toEqual([]);
		seed(await message(peer, peerKey, 5, [holding('stored')], { message_id: at(5) }));
		expect((await store.readPeerParts(peer.userHash, ['recovery_holding'], { newestMatch: () => true, after: at(3) })).messages.map((m) => m.messageId)).toEqual([at(5)]);
	});

	it('names a message delivered only on the peer\'s own verified receipt', async () => {
		seed(await message(me, myKey, 1, [{ kind: 'text', text: 'share' }]), await message(me, myKey, 2, [{ kind: 'text', text: 'other' }]));
		const forged = receipt(peer, id(2), 'delivered');
		collections.dialog.receipts.rows = new Map([
			['a', receipt(peer, id(1), 'delivered')],
			['b', receipt(peer, id(1), 'read')],
			['c', receipt(me, id(2), 'delivered')],
			['d', { ...forged, owner_timestamp: 1_700_000_901 }],
		]);
		const read = await store.readPeerParts(peer.userHash, ['recovery_holding'], { deliveredOf: [id(1), id(2)] });
		expect(read.delivered).toEqual([id(1)]);
	});

	it('answers null once another account is signed in, and when the read outlasts its budget', async () => {
		seed(await message(peer, peerKey, 1, [holding('stored')]));
		const pending = store.readPeerParts(peer.userHash, ['recovery_holding']);
		HOLDER.user.currentUserHash = 'u_' + 'z'.repeat(128);
		expect(await pending).toBeNull();

		HOLDER.user.currentUserHash = me.userHash;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			collections.dialog.messages.preload = () => new Promise(() => {});
			const stalled = store.readPeerParts(peer.userHash, ['recovery_holding']);
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await stalled).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
