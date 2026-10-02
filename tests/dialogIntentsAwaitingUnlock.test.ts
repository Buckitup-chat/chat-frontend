import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { makeTestIdentity, signRow, signedDialogKeyRow } from './helpers/signedFixtures';

type Row = Record<string, unknown>;

const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string } | null, vault: {} as Record<string, string>, locked: false }));
const HTTP = vi.hoisted(() => ({ bodies: [] as Row[][], failNext: 0 }));

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map<string, unknown>(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});
type Collection = ReturnType<typeof makeCollection>;
let collections: { cards: Collection; dialog: { keys: Collection; messages: Collection; versions: Collection; reactions: Collection; receipts: Collection } };

vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user ??= reactive({ currentUserHash: '' });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (_h: string, read: (d: typeof collections.dialog) => unknown) => read(collections.dialog),
}));
vi.mock('@/api/client', async (importOriginal) => ({
	api: {
		...(await importOriginal<typeof import('@/api/client')>()).api,
		ingestWithAuthEach: async (mutations: Array<{ modified?: Row; changes?: Row }>) => {
			HTTP.bodies.push(mutations.map((m) => JSON.parse(JSON.stringify(m.modified ?? m.changes))));
			if (HTTP.failNext > 0) { HTTP.failNext--; throw new TypeError('Failed to fetch'); }
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 1 })) }) } as unknown as Response;
		},
	},
}));
vi.mock('@/libs/EncryptionManagerPQ', async () => {
	const { VaultLockedError } = await import('@/lib/data/keyCustody');
	return {
		EncryptionManagerPQ: {
			getInstance: () => ({
				exportVaultKeys: async () => {
					if (HOLDER.locked) throw new VaultLockedError('the vault is locked');
					return HOLDER.vault;
				},
			}),
		},
	};
});

const memStore = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const me = makeTestIdentity(71, 'me');
const peer = makeTestIdentity(72, 'peer');
const other = makeTestIdentity(73, 'other');
const MESSAGE_ID = 'dmsg_0199eeee-0000-7000-8000-000000000001';

let disk: Record<'kv' | 'intents' | 'outbox' | 'accepted' | 'tails' | 'projections', ReturnType<typeof memStore>>;

const boot = async () => {
	const outbox = await import('@/lib/data/outbox');
	const intents = await import('@/lib/data/intents');
	(await import('@/lib/data/localStore'))._setStoreForTests(disk.kv);
	intents._setIntentStorageForTests(disk.intents);
	outbox._setStorageForTests(disk.outbox);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(disk.accepted);
	(await import('@/lib/data/ownObservedTails'))._setOwnObservedTailsStorageForTests(disk.tails);
	(await import('@/lib/data/messageProjections'))._setProjectionStorageForTests(disk.projections);
	(await import('@/lib/data/cardRegistry')).resetCardRegistry();
	outbox.stopLeaderElection();
	outbox.startLeaderElection(HOLDER.user!.currentUserHash, () => {});
	if (!navigator.locks) outbox._setLeaderForTests(true);
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
	setActivePinia(createPinia());
	const store = (await import('@/store/dialogs.store')).useDialogsStore();
	const recovery = await import('@/lib/data/intentRecovery');
	const { materializeMessageIntent } = await import('@/lib/data/messageIntent');
	const { VaultLockedError } = await import('@/lib/data/keyCustody');
	const ingest = await import('@/lib/data/ingest');
	return {
		store, outbox, intents, ingest,
		unlock: async () => {
			HOLDER.locked = false;
			const who = HOLDER.user!.currentUserHash;
			const vault = who === me.userHash ? me : other;
			await recovery.recoverIntents(who, async () => {
				if (HOLDER.locked) throw new VaultLockedError('locked');
				return vault.signSkey;
			}, { materializeMessage: materializeMessageIntent });
			await vi.waitFor(async () => expect(await dueIds(outbox)).toEqual([]), { timeout: 4000 });
		},
	};
};
type Page = Awaited<ReturnType<typeof boot>>;
const dueIds = async (outbox: Page['outbox']) =>
	(await outbox.pendingEntries(HOLDER.user!.currentUserHash)).filter((e) => e.status !== 'accepted' && !e.nextAttemptAt).map((e) => e.id);
const reload = async (page: Page) => {
	page.outbox.stopDrainLoop();
	page.outbox.stopLeaderElection();
	await page.outbox._drainLoopSettledForTests();
	vi.resetModules();
	return boot();
};
const intentsOf = async (page: Page, who = me) => (await page.intents.intentsOf(who.userHash)).entries;

let page: Page;
let dialogHash: string;
let myKey: Uint8Array;
let tip: Row;

const DialogCrypto = async () => (await import('@/libs/DialogCrypto')).DialogCrypto;
const encodeContent = async () => (await import('@/lib/pq/content')).encodeContent;
const decrypt = async (b64: unknown) => (await DialogCrypto()).decryptContent(myKey, b64 as string);
const messageRevision = async (text: string, ts: number, parent: string | null) => signRow(me, {
	message_id: MESSAGE_ID, dialog_hash: dialogHash, sender_hash: me.userHash,
	content_b64: await (await DialogCrypto()).encryptContent(myKey, (await encodeContent())([{ kind: 'text', text }])),
	deleted_flag: false, refs_map_b64: await (await DialogCrypto()).encryptContent(myKey, '{}'),
	parent_sign_hash: parent, owner_timestamp: ts,
}, 'dms_');

beforeEach(async () => {
	HTTP.bodies = [];
	HTTP.failNext = 0;
	HOLDER.locked = false;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	disk = { kv: memStore(), intents: memStore(), outbox: memStore(), accepted: memStore(), tails: memStore(), projections: memStore() };
	collections = {
		cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card, [other.userHash]: other.card }),
		dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
	};
	vi.resetModules();
	const { reactive } = await import('vue');
	HOLDER.user ??= reactive({ currentUserHash: '' });
	HOLDER.user!.currentUserHash = me.userHash;
	HOLDER.vault = me.vault;
	page = await boot();
	dialogHash = page.store.getDialogHash(peer.userHash)!;
	collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, signedDialogKeyRow(me, { dialog_hash: dialogHash, peer_hash: peer.userHash }));
	myKey = (await DialogCrypto()).deriveSenderMsgKey(me.signSkey, me.kemSkey, me.vault.evm_skey, peer.userHash);
	tip = await messageRevision('original', 1_700_000_100, null);
	collections.dialog.messages.rows.set(MESSAGE_ID, tip);
	await page.store.admitMessageRow(tip); // as the chat does when it renders the message
});

afterEach(async () => {
	page.outbox._setLeaderForTests(null);
	page.outbox.stopDrainLoop();
	page.outbox.stopLeaderElection();
	await page.outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

const sentOf = (relation: string) => HTTP.bodies.map((b) => b[0]).filter((r) =>
	relation === 'dialog_messages' ? 'message_id' in r && !('reaction_hash' in r) && !('receipt_hash' in r)
		: relation === 'reactions' ? 'reaction_hash' in r : 'receipt_hash' in r);

describe('locked: the action is a durable intent, nothing else', () => {
	it('an edit with the vault locked is stored with its content and refs; no snapshot, no signature, no request', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'edited while locked')).toMatchObject({ status: 'awaiting_unlock', signHash: null });
		const [intent] = await intentsOf(page);
		expect(intent.intent).toMatchObject({ kind: 'edit', messageId: MESSAGE_ID, dialogHash, ownerHash: me.userHash, parts: [{ kind: 'text', text: 'edited while locked' }] });
		expect((intent.intent as Row).observedTails).toEqual({ [MESSAGE_ID]: tip.sign_hash });
		expect(intent.intent).not.toHaveProperty('signedMutation');
		expect(intent.awaiting?.phase).toBe('AWAITING_UNLOCK');
		expect(disk.outbox.map.size).toBe(0);
		expect(HTTP.bodies).toEqual([]);
	});

	it('unlock without a reload: the same intent is signed once and sent once', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'edited')).toMatchObject({ status: 'awaiting_unlock' });
		const [{ id }] = await intentsOf(page);
		await page.unlock();
		expect(await intentsOf(page)).toEqual([]);
		expect((await page.intents.getIntent(id))?.intent).toMatchObject({ resolved: true });
		const [sent] = sentOf('dialog_messages');
		expect(sentOf('dialog_messages')).toHaveLength(1);
		expect(sent.parent_sign_hash).toBe(tip.sign_hash);
		expect(JSON.parse((await decrypt(sent.refs_map_b64)) as string)).toEqual({ [MESSAGE_ID]: tip.sign_hash });
	});

	it('unlock after a real module reload: the same intent id, one snapshot, one request', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'edited before reload')).toMatchObject({ status: 'awaiting_unlock' });
		const [{ id, intent }] = await intentsOf(page);
		page = await reload(page);
		expect((await intentsOf(page)).map((e) => [e.id, e.intent])).toEqual([[id, intent]]);
		await page.unlock();
		expect((await page.intents.getIntent(id))?.intent).toMatchObject({ resolved: true });
		expect(HTTP.bodies).toHaveLength(1);
		expect([...disk.outbox.map.keys()].filter((k) => !k.includes('|'))).toHaveLength(1);
	});

	it('another account\'s session neither signs nor sends the intent; its owner\'s unlock does', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'mine')).toMatchObject({ status: 'awaiting_unlock' });
		HOLDER.user!.currentUserHash = other.userHash;
		HOLDER.vault = other.vault;
		page = await reload(page);
		await page.unlock();
		expect(HTTP.bodies).toEqual([]);
		HOLDER.user!.currentUserHash = me.userHash;
		HOLDER.vault = me.vault;
		page = await reload(page);
		await page.unlock();
		expect(sentOf('dialog_messages')).toHaveLength(1);
	});
});

describe('edits and deletes', () => {
	it('a newer trusted revision while locked becomes the base; the captured refs do not change', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'my edit')).toMatchObject({ status: 'awaiting_unlock' });
		const newer = await messageRevision('edited elsewhere', 1_700_000_200, tip.sign_hash as string);
		collections.dialog.messages.rows.set(MESSAGE_ID, newer);
		await page.unlock();
		const [sent] = sentOf('dialog_messages');
		expect(sent.parent_sign_hash).toBe(newer.sign_hash);
		expect(Number(sent.owner_timestamp)).toBeGreaterThan(1_700_000_200);
		expect(JSON.parse((await decrypt(sent.refs_map_b64)) as string)).toEqual({ [MESSAGE_ID]: tip.sign_hash });
	});

	it('a delete after an unsigned edit is its successor once recovered, never a sibling', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'edit first')).toMatchObject({ status: 'awaiting_unlock' });
		expect(await page.store.deleteMessage(peer.userHash, MESSAGE_ID)).toMatchObject({ status: 'awaiting_unlock' });
		expect((await intentsOf(page)).map((e) => (e.intent as Row).kind)).toEqual(['edit', 'delete']);
		page = await reload(page);
		await page.unlock();
		const [edit, deletion] = sentOf('dialog_messages');
		expect(edit.parent_sign_hash).toBe(tip.sign_hash);
		expect(deletion).toMatchObject({ deleted_flag: true, content_b64: null, parent_sign_hash: edit.sign_hash });
	});

	it('a signed edit is not rebuilt after a reload: the same bytes go out again', async () => {
		HTTP.failNext = 1;
		await expect(page.store.editMessage(peer.userHash, MESSAGE_ID, 'signed, then lost')).rejects.toThrow();
		const first = HTTP.bodies[0];
		page = await reload(page);
		await page.unlock();
		page.ingest.drainPendingWrites(me.userHash, me.signSkey);
		const [entry] = (await page.outbox.pendingEntries(me.userHash));
		if (entry) await page.outbox.requeueEntry(entry.id);
		page.ingest.drainPendingWrites(me.userHash, me.signSkey);
		await vi.waitFor(() => expect(HTTP.bodies).toHaveLength(2), { timeout: 4000 });
		expect(JSON.stringify(HTTP.bodies[1])).toBe(JSON.stringify(first));
	});
});

describe('reaction toggles', () => {
	const toggle = (active: boolean, messageSignHash = tip.sign_hash as string) =>
		page.store.toggleReaction(peer.userHash, { messageId: MESSAGE_ID, messageSignHash, emoji: '👍', active });
	const reactionIntents = async () => (await intentsOf(page)).filter((e) => (e.intent as Row).kind === 'reaction');

	it('locked toggles are one durable intent holding the final desired state, across a reload', async () => {
		HOLDER.locked = true;
		await toggle(false);
		await vi.waitFor(async () => expect(await reactionIntents()).toHaveLength(1));
		await toggle(true);
		await toggle(false);
		await vi.waitFor(async () => expect((await reactionIntents())[0]?.intent).toMatchObject({ desiredActive: true }));
		expect(await reactionIntents()).toHaveLength(1);
		expect(HTTP.bodies).toEqual([]);

		page = await reload(page);
		await toggle(true);
		await vi.waitFor(async () => expect((await reactionIntents())[0]?.intent).toMatchObject({ desiredActive: false }));
		await toggle(false);
		await vi.waitFor(async () => expect((await reactionIntents())[0]?.intent).toMatchObject({ desiredActive: true }));
		expect(await reactionIntents()).toHaveLength(1);

		await page.unlock();
		const sent = sentOf('reactions');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ deleted_flag: false, message_sign_hash: tip.sign_hash });
	});

	it('toggled back to its current state before signing writes nothing', async () => {
		HOLDER.locked = true;
		await toggle(false);
		await vi.waitFor(async () => expect(await reactionIntents()).toHaveLength(1));
		await toggle(true);
		await vi.waitFor(async () => expect((await reactionIntents())[0]?.intent).toMatchObject({ desiredActive: false }));
		await page.unlock();
		expect(HTTP.bodies).toEqual([]);
		expect(await reactionIntents()).toEqual([]);
	});

	it('a toggle discarded before it was signed is never sent', async () => {
		HOLDER.locked = true;
		const optimisticId = await toggle(false);
		await vi.waitFor(async () => expect(await reactionIntents()).toHaveLength(1));
		page.store.discardFailedItem(optimisticId);
		await vi.waitFor(async () => expect(await reactionIntents()).toEqual([]));
		await page.unlock();
		expect(HTTP.bodies).toEqual([]);
	});

	it('after signing, the next toggle is a revision of its own, built on the previous one', async () => {
		await toggle(false);
		await vi.waitFor(() => expect(sentOf('reactions')).toHaveLength(1));
		await toggle(true);
		await vi.waitFor(() => expect(sentOf('reactions')).toHaveLength(2));
		const [on, off] = sentOf('reactions');
		expect(off).toMatchObject({ reaction_hash: on.reaction_hash, deleted_flag: true });
		expect(Number(off.owner_timestamp)).toBeGreaterThan(Number(on.owner_timestamp));
	});

	it('a toggle on another revision is another action: each keeps the revision it was aimed at', async () => {
		HOLDER.locked = true;
		await toggle(false);
		await vi.waitFor(async () => expect(await reactionIntents()).toHaveLength(1));
		const edited = await messageRevision('edited', 1_700_000_300, tip.sign_hash as string);
		collections.dialog.messages.rows.set(MESSAGE_ID, edited);
		await toggle(false, edited.sign_hash as string);
		await vi.waitFor(async () => expect(await reactionIntents()).toHaveLength(2));
		await page.unlock();
		expect(sentOf('reactions').map((r) => r.message_sign_hash)).toEqual([tip.sign_hash, edited.sign_hash]);
	});
});

describe('receipts', () => {
	const ref = () => ({ messageId: MESSAGE_ID, messageSignHash: tip.sign_hash as string });
	const receiptIntents = async () => (await intentsOf(page)).filter((e) => (e.intent as Row).kind === 'receipt');

	it('a locked receipt survives a reload and goes out once after the unlock', async () => {
		page = await reload(page);
		HOLDER.locked = true;
		await expect(page.store.sendReadReceipt(peer.userHash, ref())).rejects.toThrow(/locked/);
		expect((await receiptIntents())[0]?.intent).toMatchObject({ kind: 'receipt', row: { message_id: MESSAGE_ID, type: 'read' } });
		expect(HTTP.bodies).toEqual([]);
		page = await reload(page);
		await page.unlock();
		expect(sentOf('receipts')).toHaveLength(1);
	});

	it('repeating an equivalent receipt makes no duplicate, locked or not', async () => {
		HOLDER.locked = true;
		await expect(page.store.sendReadReceipt(peer.userHash, ref())).rejects.toThrow();
		await expect(page.store.sendReadReceipt(peer.userHash, ref())).rejects.toThrow();
		expect(await receiptIntents()).toHaveLength(1);
		await page.unlock();
		await page.store.sendReadReceipt(peer.userHash, ref());
		expect(sentOf('receipts')).toHaveLength(1);
	});

	it('exact acceptance completes a receipt without waiting for its shape row', async () => {
		await page.store.sendReadReceipt(peer.userHash, ref());
		expect(collections.dialog.receipts.rows.size).toBe(0);
		expect(sentOf('receipts')).toHaveLength(1);
		expect(await receiptIntents()).toEqual([]);
	});
});

describe('a locked edit or delete is stored and waiting, not failed', () => {
	it('locked edit and delete resolve as awaiting unlock, and the unlock finishes them with no new action', async () => {
		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'later')).toEqual({ messageId: MESSAGE_ID, status: 'awaiting_unlock', signHash: null, ownerTimestamp: null });
		expect(await page.store.deleteMessage(peer.userHash, MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, status: 'awaiting_unlock' });
		expect((await intentsOf(page)).map((e) => [(e.intent as Row).kind, e.awaiting?.phase])).toEqual([['edit', 'AWAITING_UNLOCK'], ['delete', 'AWAITING_UNLOCK']]);
		await page.unlock();
		expect(sentOf('dialog_messages').map((r) => r.deleted_flag)).toEqual([false, true]);
		expect(await intentsOf(page)).toEqual([]);
	});

	it('an edit or delete that could not be stored is a real error', async () => {
		HOLDER.locked = true;
		disk.intents.set = async () => { throw new Error('intent storage down'); };
		await expect(page.store.editMessage(peer.userHash, MESSAGE_ID, 'lost')).rejects.toThrow(/could not be stored/);
		await expect(page.store.deleteMessage(peer.userHash, MESSAGE_ID)).rejects.toThrow(/could not be stored/);
		expect(HTTP.bodies).toEqual([]);
	});
});

describe('without Web Locks, work on one intent is still one at a time', () => {
	const gateAwaitingMark = () => {
		const set = disk.intents.set.bind(disk.intents);
		let release!: () => void;
		const held = new Promise<void>((r) => { release = r; });
		let reached = false;
		disk.intents.set = async (k: string, v: string) => {
			if (v.includes('AWAITING_UNLOCK') && !reached) { reached = true; await held; }
			return set(k, v);
		};
		return { release, reached: () => reached };
	};
	beforeEach(async () => {
		vi.stubGlobal('navigator', {});
		page = await reload(page);
		await page.store.admitMessageRow(tip);
	});

	it('an edit folded in while the first pass marks the intent awaiting unlock is kept; its content is what gets signed', async () => {
		HOLDER.locked = true;
		const gate = gateAwaitingMark();
		const first = page.store.editMessage(peer.userHash, MESSAGE_ID, 'old text');
		await vi.waitFor(() => expect(gate.reached()).toBe(true));
		const second = page.store.editMessage(peer.userHash, MESSAGE_ID, 'new text');
		await new Promise((r) => setTimeout(r, 20));
		gate.release();
		await first;
		await second;
		const [only] = await intentsOf(page);
		expect((await intentsOf(page))).toHaveLength(1);
		expect((only.intent as Row).parts).toEqual([{ kind: 'text', text: 'new text' }]);
		await page.unlock();
		const sent = sentOf('dialog_messages');
		expect(sent).toHaveLength(1);
		expect((await page.outbox.pendingEntries(me.userHash))).toEqual([]);
		const text = await decrypt(sent[0].content_b64);
		expect(JSON.stringify(text)).toContain('new text');
	});

	it('a toggle folded in while the first pass marks it awaiting unlock is kept: the reaction ends where the user left it', async () => {
		HOLDER.locked = true;
		const gate = gateAwaitingMark();
		await page.store.toggleReaction(peer.userHash, { messageId: MESSAGE_ID, messageSignHash: tip.sign_hash as string, emoji: '👍', active: false });
		await vi.waitFor(() => expect(gate.reached()).toBe(true));
		const second = page.store.toggleReaction(peer.userHash, { messageId: MESSAGE_ID, messageSignHash: tip.sign_hash as string, emoji: '👍', active: true });
		await new Promise((r) => setTimeout(r, 20));
		gate.release();
		await second;
		await vi.waitFor(async () => expect((await intentsOf(page))[0]?.intent).toMatchObject({ desiredActive: false }));
		expect(await intentsOf(page)).toHaveLength(1);
		await page.unlock();
		expect(HTTP.bodies).toEqual([]);
		expect(await intentsOf(page)).toEqual([]);
	});

	it('two signing attempts of one intent make one snapshot; a failing turn does not hold up the next; other intents do not wait', async () => {
		const { withIntentSigningLock } = await import('@/lib/data/intentRecovery');
		await expect(withIntentSigningLock('intent-a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		expect(await withIntentSigningLock('intent-a', async () => 'next')).toBe('next');

		let releaseA!: () => void;
		const heldA = withIntentSigningLock('intent-a', () => new Promise<void>((r) => { releaseA = r; }));
		expect(await withIntentSigningLock('intent-b', async () => 'b ran')).toBe('b ran');
		let secondA = false;
		const queuedA = withIntentSigningLock('intent-a', async () => { secondA = true; });
		await new Promise((r) => setTimeout(r, 10));
		expect(secondA).toBe(false);
		releaseA();
		await heldA;
		await queuedA;
		expect(secondA).toBe(true);

		HOLDER.locked = true;
		expect(await page.store.editMessage(peer.userHash, MESSAGE_ID, 'once')).toMatchObject({ status: 'awaiting_unlock' });
		HOLDER.locked = false;
		const recovery = await import('@/lib/data/intentRecovery');
		const { materializeMessageIntent } = await import('@/lib/data/messageIntent');
		const both = [0, 1].map(() => recovery.recoverIntents(me.userHash, async () => me.signSkey, { materializeMessage: materializeMessageIntent }));
		await Promise.all(both);
		await vi.waitFor(() => expect(sentOf('dialog_messages')).toHaveLength(1));
		expect([...disk.outbox.map.keys()].filter((k) => !k.includes('|'))).toHaveLength(1);
	});
});
