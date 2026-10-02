import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deriveFrontierRoot, buildViewTree, CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION } from '@/lib/pq/checkpoint';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { makeTestIdentity, signRow, signedDialogKeyRow } from './helpers/signedFixtures';

type Row = Record<string, unknown>;

const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string } | null, vault: {} as Record<string, string> }));
const HTTP = vi.hoisted(() => ({ bodies: [] as Row[][], failNext: 0, gate: null as Promise<void> | null }));
const GATE = vi.hoisted(() => ({ preload: null as Promise<void> | null, vault: null as Promise<void> | null, kvWrite: null as Promise<void> | null, kvReached: 0 }));

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map<string, unknown>(Object.entries(rows)),
	async preload() { if (GATE.preload) await GATE.preload; },
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});
type Collection = ReturnType<typeof makeCollection>;
let collections: { cards: Collection; dialog: { keys: Collection; messages: Collection; versions: Collection; reactions: Collection; receipts: Collection } };

vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '' });
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
			if (HTTP.gate) await HTTP.gate;
			HTTP.bodies.push(mutations.map((m) => JSON.parse(JSON.stringify(m.modified ?? m.changes))));
			if (HTTP.failNext > 0) { HTTP.failNext--; throw new TypeError('Failed to fetch'); }
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 1 })) }) } as unknown as Response;
		},
	},
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => { if (GATE.vault) await GATE.vault; return HOLDER.vault; } }) },
}));

const { resetCardRegistry } = await import('@/lib/data/cardRegistry');
const { _setStoreForTests } = await import('@/lib/data/localStore');
const outbox = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, intentsOf } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { _setProjectionStorageForTests } = await import('@/lib/data/messageProjections');
const { createSecureStore } = await import('@/lib/data/secureStore');
const { AccountMismatchError } = await import('@/lib/data/keyCustody');
const { SessionFencedError } = await import('@/lib/data/sessionGuard');
const ingest = await import('@/lib/data/ingest');
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');
const { encodeContent } = await import('@/lib/pq/content');

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
const deferred = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };

const me = makeTestIdentity(61, 'me');
const peer = makeTestIdentity(62, 'peer');
const other = makeTestIdentity(63, 'other');
let store: ReturnType<typeof useDialogsStore>;
let dialogHash: string;
let myKey: Uint8Array;
const MESSAGE_ID = 'dmsg_0199dddd-0000-7000-8000-000000000001';

const switchTo = (who: typeof me) => {
	outbox.stopLeaderElection();
	HOLDER.user!.currentUserHash = who.userHash;
	HOLDER.vault = who.vault;
	outbox.startLeaderElection(who.userHash, () => {});
};

beforeEach(async () => {
	resetCardRegistry();
	HTTP.bodies = [];
	HTTP.failNext = 0;
	HTTP.gate = null;
	GATE.preload = null;
	GATE.vault = null;
	GATE.kvWrite = null;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	const kv = memStore();
	GATE.kvReached = 0;
	_setStoreForTests({ ...kv, set: async (k: string, v: string) => { if (GATE.kvWrite && k.startsWith('cpptr|')) { GATE.kvReached++; await GATE.kvWrite; } await kv.set(k, v); } });
	_setIntentStorageForTests(memStore());
	outbox._setStorageForTests(memStore());
	_setAcceptedSnapshotStorageForTests(memStore());
	_setOwnObservedTailsStorageForTests(memStore());
	_setProjectionStorageForTests(memStore());
	collections = {
		cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card, [other.userHash]: other.card }),
		dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
	};
	switchTo(me);
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
	setActivePinia(createPinia());
	store = useDialogsStore();
	dialogHash = store.getDialogHash(peer.userHash)!;
	collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, signedDialogKeyRow(me, { dialog_hash: dialogHash, peer_hash: peer.userHash }));
	myKey = DialogCrypto.deriveSenderMsgKey(me.signSkey, me.kemSkey, me.vault.evm_skey, peer.userHash);
	collections.dialog.messages.rows.set(MESSAGE_ID, signRow(me, {
		message_id: MESSAGE_ID, dialog_hash: dialogHash, sender_hash: me.userHash,
		content_b64: await DialogCrypto.encryptContent(myKey, encodeContent([{ kind: 'text', text: 'original' }])),
		deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(myKey, '{}'),
		parent_sign_hash: null, owner_timestamp: 1_700_000_100,
	}, 'dms_'));
});

afterEach(async () => {
	GATE.preload = null;
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

const original = () => collections.dialog.messages.rows.get(MESSAGE_ID) as Row;
const pendingIds = async () => (await outbox.pendingEntries(me.userHash)).filter((e) => e.status !== 'accepted').map((e) => e.id);

describe('a signed write still on its way is the next revision\'s base', () => {
	it('an edit after a signed edit that failed in transit chains on it; the first is sent again byte for byte', async () => {
		HTTP.failNext = 1;
		await expect(store.editMessage(peer.userHash, MESSAGE_ID, 'first edit')).rejects.toThrow();
		const first = HTTP.bodies[0][0];
		expect(first.parent_sign_hash).toBe(original().sign_hash);
		const [firstEntry] = await pendingIds();

		const second = store.editMessage(peer.userHash, MESSAGE_ID, 'second edit');
		await vi.waitFor(async () => expect(await pendingIds()).toHaveLength(2));
		await outbox.requeueEntry(firstEntry);
		ingest.drainPendingWrites(me.userHash, me.signSkey);
		await second;

		const sentAgain = HTTP.bodies.filter((b) => b[0].sign_hash === first.sign_hash);
		expect(sentAgain).toHaveLength(2);
		expect(JSON.stringify(sentAgain[1])).toBe(JSON.stringify(HTTP.bodies[0]));
		const last = HTTP.bodies.at(-1)![0];
		expect(last.parent_sign_hash).toBe(first.sign_hash);
		expect(Number(last.owner_timestamp)).toBeGreaterThan(Number(first.owner_timestamp));
		expect(new Set(HTTP.bodies.map((b) => b[0].sign_hash)).size).toBe(2); // two revisions, three requests
	});

	it('a reaction toggled again after its insert failed in transit updates that insert, never inserts twice', async () => {
		const messageSignHash = original().sign_hash as string;
		HTTP.failNext = 1;
		store.toggleReaction(peer.userHash, { messageId: MESSAGE_ID, messageSignHash, emoji: '👍', active: false });
		await vi.waitFor(() => expect(HTTP.bodies).toHaveLength(1));
		const insert = HTTP.bodies[0][0];
		await vi.waitFor(async () => expect(await pendingIds()).toHaveLength(1));
		const [insertEntry] = await pendingIds();
		await vi.waitFor(() => expect([...store.optimisticItems.values()].some((i) => i.type === 'reaction' && i.status === 'error')).toBe(true));

		store.toggleReaction(peer.userHash, { messageId: MESSAGE_ID, messageSignHash, emoji: '👍', active: true });
		await vi.waitFor(async () => expect(await pendingIds()).toHaveLength(2));
		const toggle = (await outbox.pendingEntries(me.userHash)).find((e) => e.id !== insertEntry)!;
		expect(toggle.mutations[0]).toMatchObject({ type: 'update' });
		const toggled = (toggle.mutations[0] as { changes: Row }).changes;
		expect(toggled.deleted_flag).toBe(true);
		expect(Number(toggled.owner_timestamp)).toBeGreaterThan(Number(insert.owner_timestamp));
		expect(toggle.dependsOn).toContain(insertEntry);
	});

	it('a delete issued while an edit is still unsigned is that edit\'s successor, not its sibling', async () => {
		await store.initDialogKeys(peer.userHash);
		const vault = deferred();
		GATE.vault = vault.promise;
		const edit = store.editMessage(peer.userHash, MESSAGE_ID, 'edited');
		await vi.waitFor(async () => expect((await intentsOf(me.userHash)).entries).toHaveLength(1));
		const deletion = store.deleteMessage(peer.userHash, MESSAGE_ID);
		await new Promise((r) => setTimeout(r, 0));
		GATE.vault = null;
		vault.release();
		await edit;
		await deletion;
		const [editRow, deleteRow] = HTTP.bodies.map((b) => b[0]);
		expect(editRow.parent_sign_hash).toBe(original().sign_hash);
		expect(deleteRow).toMatchObject({ deleted_flag: true, parent_sign_hash: editRow.sign_hash });
	});
});

describe('a switch of account during construction writes nothing', () => {
	it('edit and delete fenced mid-construction: no intent for either account, nothing signed or sent', async () => {
		for (const act of [
			() => store.editMessage(peer.userHash, MESSAGE_ID, 'while switching'),
			() => store.deleteMessage(peer.userHash, MESSAGE_ID),
		]) {
			switchTo(me);
			const hold = deferred();
			GATE.preload = hold.promise;
			const pending = act();
			await vi.waitFor(() => expect(GATE.preload).not.toBeNull());
			await new Promise((r) => setTimeout(r, 0));
			switchTo(other);
			hold.release();
			await expect(pending).rejects.toBeInstanceOf(SessionFencedError);
			GATE.preload = null;
		}
		expect((await intentsOf(me.userHash)).entries).toHaveLength(0);
		expect((await intentsOf(other.userHash)).entries).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);
	});

	it('an outbox record is sealed for its owner — after a switch it is refused, not sealed for the other account', async () => {
		const raw = memStore();
		let active = me.userHash;
		const keys = new Map<string, CryptoKey>();
		const keyOf = async (owner: string) => {
			if (!keys.has(owner)) keys.set(owner, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
			return keys.get(owner)!;
		};
		const live = createSecureStore(raw, { getKey: () => keyOf(active) });
		outbox._setStorageForTests(live, raw, {
			sealFor: (owner) => createSecureStore(raw, {
				getKey: async () => {
					if (owner !== active) throw new AccountMismatchError('another account is open');
					return keyOf(owner);
				},
			}),
		});
		const mutation = [{ type: 'insert', modified: { receipt_hash: 'dmrc_' + 'a'.repeat(128), peer_hash: me.userHash, dialog_hash: dialogHash }, syncMetadata: { relation: 'dialog_message_receipts' } }];
		expect(await outbox.enqueue(mutation, me.userHash)).toBeTruthy();

		active = other.userHash;
		const before = [...raw.map.keys()].length;
		expect(await outbox.enqueue(mutation, me.userHash)).toBeNull();
		expect([...raw.map.keys()]).toHaveLength(before);
		const [id] = [...raw.map.keys()].filter((k) => !k.includes('|'));
		await expect(live.get(id)).rejects.toThrow();
	});

	it('a checkpoint alert scan that outlives its session records nothing for the next', async () => {
		const carrier = signRow(me, {
			message_id: 'dmsg_0199dddd-0000-7000-8000-000000000009', dialog_hash: dialogHash, sender_hash: me.userHash,
			content_b64: await DialogCrypto.encryptContent(myKey, encodeContent([{
				kind: 'checkpoint', version: CHECKPOINT_VERSION, reducerVersion: REDUCER_VERSION, treeVersion: TREE_VERSION,
				frontierRoot: deriveFrontierRoot({}), viewRoot: buildViewTree({ [MESSAGE_ID]: { signHash: original().sign_hash as string, deleted: false } }).root,
				frontier: {}, createdAt: 1_700_000_400,
			}] as never)),
			deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(myKey, '{}'), parent_sign_hash: null, owner_timestamp: 1_700_000_500,
		}, 'dms_');
		collections.dialog.messages.rows.set(carrier.message_id as string, carrier);
		const write = deferred();
		GATE.kvWrite = write.promise;
		const scan = store.refreshCheckpointAlert(peer.userHash);
		await vi.waitFor(() => expect(GATE.kvReached).toBeGreaterThan(0), { timeout: 4000 });
		switchTo(other);
		GATE.kvWrite = null;
		write.release();
		expect(await scan).toBeNull();
		expect(store.checkpointAlerts.size).toBe(0);
	});
});

describe('one transport', () => {
	const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sources(path) : /\.(ts|js|vue)$/.test(name) ? [path] : [];
	});
	const production = sources(join(process.cwd(), 'src')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

	it('no production module posts a mutation except the sender\'s transport', () => {
		const offenders = production.filter(({ text }) =>
			/\bapi\.ingest(WithAuth)?\(|\bingestWithAuth\(|fetch\([^)]*\/ingest/.test(text));
		expect(offenders.map((o) => o.path)).toEqual([]);
		const callers = production.filter(({ text }) => /\.ingestWithAuthEach\(/.test(text)).map((o) => o.path.replace(process.cwd() + '/', ''));
		expect(callers).toEqual(['src/lib/data/ingest.ts']);
		const client = production.find((o) => o.path.endsWith('src/api/client.js'))!.text;
		expect(client).not.toMatch(/^\s+ingest(WithAuth)?:/m);
		const directSends = production.filter(({ path, text }) => !path.endsWith('src/lib/data/ingest.ts') && /\bsendMutations(WithRetry)?\(/.test(text));
		expect(directSends.map((o) => o.path)).toEqual([]);
	});
});
