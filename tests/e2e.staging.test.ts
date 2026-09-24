// Full user-flow E2E against the live staging backend, driven through the
// same modules the browser runs — DialogCrypto, the content codec, the
// signature module, the file transport, and the verification gate. Gated
// behind E2E=1 so CI never talks to the network:
//
//   E2E=1 npx vitest run tests/e2e.staging.test.ts
//
// Two fresh accounts hold a conversation: keys are wrapped and unwrapped for
// real, messages travel through the real production write path — the
// coordinator's dispatchMutations, its durable outbox, exact SERVER_ACCEPTED
// classification and accepted-snapshot reconciliation, over the real
// /ingest_each endpoint (src/lib/data/ingest.ts's sendMutationsAndAwaitShape,
// the same entry point dialogs.store.js's sendMessage funnels every live send
// through) — and come back through shapes, the receive side admits rows
// through the gate before trusting them, a reply carries its quote snapshot,
// an edit archives a version, and a file round-trips through the chunk
// endpoints byte-identical.
import { describe, it, expect, vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { v7 as uuidv7 } from 'uuid';
import { ShapeStream, isChangeMessage } from '@electric-sql/client';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent, decodeContent, contentToText, type ContentPart } from '@/lib/pq/content';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import { createDialogGate } from '@/lib/data/dialogGate';
import { uploadFile, downloadFile, prepareUpload } from '@/lib/data/fileTransfer';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { sendMutationsAndAwaitShape, sendMutationsWithRetry, type SendResult } from '@/lib/data/ingest';
import {
	_setStorageForTests as _setOutboxStorageForTests, _setLeaderForTests, enqueue, drainOutbox,
} from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests, getAccepted } from '@/lib/data/acceptedSnapshot';
import { reconcileAccepted } from '@/lib/data/coordinator';

const BASE = 'https://buckitup.xyz/electric/v1';
(globalThis as Record<string, unknown>).ELECTRIC_API_URL = BASE;

const makeMemStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

interface MinimalShapeStream {
	readonly isUpToDate: boolean;
	subscribe(
		callback: (messages: unknown[]) => void,
		onError?: (error: unknown) => void
	): () => void;
}
type ShapeStreamFactory = (opts: {
	url: string;
	params: { table: string; where: string };
	signal: AbortSignal;
}) => MinimalShapeStream;

interface DialogKeysStream {
	awaitTxId: (txId: number, timeoutMs?: number) => Promise<void>;
	ready: Promise<void>;
	dispose: () => void;
}

const dialogKeysStreams = new Map<string, DialogKeysStream>();

function ensureDialogKeysStream(
	dialogHash: string,
	streamFactory: ShapeStreamFactory = (opts) => new ShapeStream(opts)
): DialogKeysStream {
	const existing = dialogKeysStreams.get(dialogHash);
	if (existing) return existing;

	const seenTxids = new Set<number>();
	const pending = new Map<number, { resolve: () => void; reject: (err: unknown) => void }>();
	const controller = new AbortController();
	let readyResolve!: () => void;
	let readyFired = false;
	const ready = new Promise<void>((resolve) => { readyResolve = resolve; });

	const stream = streamFactory({
		url: `${BASE}/shapes`,
		params: { table: 'dialog_keys', where: `dialog_hash = '${dialogHash}'` },
		signal: controller.signal,
	});

	const unsubscribe = stream.subscribe(
		(messages) => {
			for (const m of messages) {
				if (!isChangeMessage(m as never)) continue;
				const txids = (m as { headers: { txids?: number[] } }).headers.txids;
				if (!txids) continue;
				for (const txId of txids) {
					seenTxids.add(txId);
					const waiter = pending.get(txId);
					if (waiter) {
						pending.delete(txId);
						waiter.resolve();
					}
				}
			}
			if (!readyFired && stream.isUpToDate) {
				readyFired = true;
				readyResolve();
			}
		},
		(err) => {
			if (controller.signal.aborted) return;
			for (const [, waiter] of pending) waiter.reject(err);
			pending.clear();
		}
	);

	const dispose = () => {
		unsubscribe();
		controller.abort();
		for (const [, waiter] of pending) waiter.reject(new Error(`dialog_keys visibility stream for ${dialogHash} disposed`));
		pending.clear();
		dialogKeysStreams.delete(dialogHash);
	};

	const awaitTxId = (txId: number, timeoutMs = 10_000): Promise<void> => {
		if (seenTxids.has(txId)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(txId);
				reject(new Error(
					`[e2e] dialog_keys visibility: txid ${txId} not observed on the persistent stream for dialog_hash=${dialogHash} within ${timeoutMs}ms`
				));
			}, timeoutMs);
			pending.set(txId, {
				resolve: () => { clearTimeout(timer); resolve(); },
				reject: (err) => { clearTimeout(timer); reject(err); },
			});
		});
	};

	const result: DialogKeysStream = { awaitTxId, ready, dispose };
	dialogKeysStreams.set(dialogHash, result);
	return result;
}

function disposeAllDialogKeysStreams(): void {
	for (const stream of dialogKeysStreams.values()) stream.dispose();
	dialogKeysStreams.clear();
}

function makeShapeVisibilityCollection(dialogHash: string) {
	return { utils: { awaitTxId: (txId: number, timeoutMs?: number) => ensureDialogKeysStream(dialogHash).awaitTxId(txId, timeoutMs) } };
}

function makeLookupCollection(table: string, dialogHash: string, key: (row: Record<string, string>) => string) {
	let cache: Map<string, Record<string, string>> | null = null;
	return {
		async preload() {
			if (cache) return;
			const rows = await shapeRows(table, `dialog_hash = '${dialogHash}'`);
			cache = new Map(rows.map((r) => [key(r), r]));
		},
		get(k: string) {
			return cache?.get(k);
		},
	};
}

vi.mock('@/lib/data/collections', () => ({
	getDialogCollections: (dialogHash: string) => ({
		keys: makeShapeVisibilityCollection(dialogHash),
		messages: makeLookupCollection('dialog_messages', dialogHash, (r) => String(r.message_id)),
		versions: undefined, reactions: undefined, receipts: undefined,
	}),
	getUserCardsCollection: () => {
		throw new Error('e2e harness: user_cards never needs shape-visibility or identity-conflict confirmation — this seam should not be reached');
	},
	getUserStorageCollection: () => {
		throw new Error('e2e harness: user_storage is not exercised by this E2E flow');
	},
}));

describe('ensureDialogKeysStream (local harness correctness, no network)', () => {
	let nextHash = 0;
	const freshHash = () => `di_test_${++nextHash}`;
	const change = (txids: number[]) => ({ key: 'k', value: {}, headers: { operation: 'insert', txids } });

	const makeFakeFactory = () => {
		let deliver: (messages: unknown[]) => void = () => {};
		let raiseError: (err: unknown) => void = () => {};
		let unsubscribed = 0;
		let upToDate = false;
		let capturedSignal: AbortSignal | undefined;
		const factory: ShapeStreamFactory = (opts) => {
			capturedSignal = opts.signal;
			return {
				get isUpToDate() { return upToDate; },
				subscribe(callback, onError) {
					deliver = callback;
					raiseError = onError ?? (() => {});
					return () => { unsubscribed++; };
				},
			};
		};
		return {
			factory,
			deliver: (messages: unknown[]) => deliver(messages),
			raiseError: (err: unknown) => raiseError(err),
			setUpToDate: (v: boolean) => { upToDate = v; },
			get unsubscribed() { return unsubscribed; },
			get signal() { return capturedSignal; },
		};
	};

	it('race: txid observed AFTER awaitTxId() is called — the pending waiter resolves', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		const p = stream.awaitTxId(42, 1000);
		fake.deliver([change([1, 42, 3])]);
		await expect(p).resolves.toBeUndefined();
		stream.dispose();
		expect(fake.unsubscribed).toBe(1);
		expect(fake.signal?.aborted).toBe(true);
	});

	it('race: txid observed BEFORE awaitTxId() is called, after the persistent stream started — served from cache', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		fake.deliver([change([99])]);
		const p = stream.awaitTxId(99, 1000);
		await expect(p).resolves.toBeUndefined();
		stream.dispose();
	});

	it('the same dialog_hash reuses one persistent stream — no second ShapeStream is created', async () => {
		const dialogHash = freshHash();
		let factoryCalls = 0;
		const fake = makeFakeFactory();
		const countingFactory: ShapeStreamFactory = (opts) => { factoryCalls++; return fake.factory(opts); };
		const a = ensureDialogKeysStream(dialogHash, countingFactory);
		const b = ensureDialogKeysStream(dialogHash, countingFactory);
		expect(b).toBe(a);
		expect(factoryCalls).toBe(1);
		a.dispose();
	});

	it('ready resolves once the stream reports isUpToDate, not merely once row data arrives', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		let readyFired = false;
		void stream.ready.then(() => { readyFired = true; });
		fake.deliver([change([1])]);
		await Promise.resolve();
		expect(readyFired).toBe(false);
		fake.setUpToDate(true);
		fake.deliver([]);
		await stream.ready;
		expect(readyFired).toBe(true);
		stream.dispose();
	});

	it('rejects — never resolves — when the target txid is never observed before the timeout', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		await expect(stream.awaitTxId(42, 30)).rejects.toThrow(/not observed/);
		stream.dispose();
	});

	it('an unrelated txid does not settle a pending waiter — it still times out normally, not early', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		const p = stream.awaitTxId(42, 30);
		fake.deliver([change([999])]);
		await expect(p).rejects.toThrow(/not observed/);
		stream.dispose();
	});

	it('a stream error rejects every pending waiter', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		const p = stream.awaitTxId(42, 1000);
		fake.raiseError(new Error('stream exploded'));
		await expect(p).rejects.toThrow('stream exploded');
		stream.dispose();
	});

	it('dispose() cleans up (unsubscribe + abort) exactly once and rejects any still-pending waiter', async () => {
		const dialogHash = freshHash();
		const fake = makeFakeFactory();
		const stream = ensureDialogKeysStream(dialogHash, fake.factory);
		const p = stream.awaitTxId(42, 1000);
		stream.dispose();
		await expect(p).rejects.toThrow(/disposed/);
		expect(fake.unsubscribed).toBe(1);
		expect(fake.signal?.aborted).toBe(true);
	});
});

const runIf = process.env.E2E === '1' ? describe : describe.skip;

interface Account {
	name: string;
	userHash: string;
	sign: { publicKey: Uint8Array; secretKey: Uint8Array };
	kem: { publicKey: Uint8Array; secretKey: Uint8Array };
	contactSkey: Uint8Array;
	card: Record<string, unknown>;
}

const ingest = async (mutations: unknown[], signSkey: Uint8Array): Promise<SendResult> => {
	const handle = await sendMutationsAndAwaitShape(mutations, signSkey);
	if (handle.phase !== 'accepted' || !handle.result) {
		throw new Error(`mutation not accepted synchronously: phase=${handle.phase}`);
	}
	const outcome = await handle.acceptance;
	if (outcome.kind !== 'accepted') {
		const reason = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
		throw new Error(`mutation not accepted: ${reason}`);
	}
	return handle.result;
};

/** The shape trails ingest by seconds — poll until the predicate holds. */
const waitRows = async (table: string, where: string, pred: (rows: Record<string, string>[]) => boolean) => {
	for (let i = 0; i < 20; i++) {
		// unique no-op condition per attempt: a cold shape's log does not
		// advance without a live subscriber, so a same-where re-read can miss
		// fresh rows indefinitely; a fresh where forces a fresh snapshot
		const rows = await shapeRows(table, `${where} AND ${1000 + i}=${1000 + i}`);
		if (pred(rows)) return rows;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`shape ${table} never satisfied predicate`);
};

const shapeRows = async (table: string, where: string) => {
	const r = await fetch(`${BASE}/shapes?table=${table}&where=${encodeURIComponent(where)}&offset=-1`);
	return ((await r.json()) as Array<{ value?: Record<string, string> }>).map((m) => m.value).filter(Boolean) as Record<string, string>[];
};

const createAccount = async (name: string): Promise<Account> => {
	const sign = ml_dsa87.keygen(randomBytes(32));
	const kem = ml_kem1024.keygen(randomBytes(64));
	const contactSkey = secp.utils.randomPrivateKey();
	const contactPk = secp.getPublicKey(contactSkey, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const fields = {
		contact_cert: ml_dsa87.sign(contactPk, sign.secretKey),
		contact_pkey: contactPk,
		crypt_cert: ml_dsa87.sign(kem.publicKey, sign.secretKey),
		crypt_pkey: kem.publicKey,
		deleted_flag: false,
		name,
		owner_timestamp: Math.floor(Date.now() / 1000),
		sign_pkey: sign.publicKey,
		user_hash: userHash,
	};
	await ingest([{
		type: 'insert', syncMetadata: { relation: 'user_cards' },
		modified: {
			user_hash: userHash, sign_pkey: toBase64(sign.publicKey),
			contact_pkey: toBase64(contactPk), contact_cert: toBase64(fields.contact_cert),
			crypt_pkey: toBase64(kem.publicKey), crypt_cert: toBase64(fields.crypt_cert),
			name, deleted_flag: false, owner_timestamp: fields.owner_timestamp,
			sign_b64: signFields(fields as never, sign.secretKey),
		},
	}], sign.secretKey);
	return { name, userHash, sign, kem, contactSkey, card: fields };
};

const sendDialogMessage = async (
	author: Account, dialogHash: string, msgKey: Uint8Array,
	parts: ContentPart[], refs: Record<string, string>,
	overrides: Partial<{ message_id: string; parent_sign_hash: string; owner_timestamp: number; deleted_flag: boolean; content: string | null }> = {},
) => {
	const messageId = overrides.message_id ?? 'dmsg_' + uuidv7();
	const contentB64 = overrides.content !== undefined
		? overrides.content
		: await DialogCrypto.encryptContent(msgKey, encodeContent(parts));
	const refsMapB64 = await DialogCrypto.encryptContent(msgKey, JSON.stringify(refs));
	const fields = {
		message_id: messageId,
		dialog_hash: dialogHash,
		sender_hash: author.userHash,
		content_b64: contentB64,
		deleted_flag: overrides.deleted_flag ?? false,
		refs_map_b64: refsMapB64,
		parent_sign_hash: overrides.parent_sign_hash ?? null,
		owner_timestamp: overrides.owner_timestamp ?? Math.floor(Date.now() / 1000),
	};
	const sign_b64 = signFields(fields as never, author.sign.secretKey);
	const row = { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	const mutation = {
		type: overrides.parent_sign_hash ? 'update' : 'insert',
		syncMetadata: { relation: 'dialog_messages' },
		...(overrides.parent_sign_hash
			? { original: { message_id: messageId, sender_hash: author.userHash, dialog_hash: dialogHash }, changes: row }
			: { modified: row }),
	};
	const sendResult = await ingest([mutation], author.sign.secretKey);
	return { ...row, sendResult, mutation };
};

runIf('E2E: two accounts hold a conversation on staging', () => {
	it('keys, messages, gate, reply with quote, edit, file — end to end', async () => {
		const outboxStore = makeMemStore();
		const acceptedStore = makeMemStore();
		_setOutboxStorageForTests(outboxStore);
		_setAcceptedSnapshotStorageForTests(acceptedStore);
		_setLeaderForTests(true);
		try {
			await runE2E();
		} finally {
			_setLeaderForTests(null);
			await outboxStore.clear();
			await acceptedStore.clear();
			disposeAllDialogKeysStreams();
		}
	}, 300000);
});

async function runE2E() {
		// ---- 1. two fresh identities, cards verified from the shape ----
		const alice = await createAccount('e2e-alice');
		const bob = await createAccount('e2e-bob');
		const aliceCardRow = (await shapeRows('user_cards', `user_hash='${alice.userHash}'`))[0];
		expect(verifyUserCard(aliceCardRow as never).status).toBe('verified');

		// ---- 2. Alice derives her key and wraps it for Bob ----
		const dialogHash = DialogCrypto.computeDialogHash(alice.userHash, bob.userHash);
		const aliceKey = DialogCrypto.deriveSenderMsgKey(
			alice.sign.secretKey, alice.kem.secretKey, alice.contactSkey, bob.userHash);
		const wrapped = await DialogCrypto.wrapSenderMsgKey(aliceKey, bob.kem.publicKey);

		const keyFields = {
			dialog_hash: dialogHash, sender_hash: alice.userHash, peer_hash: bob.userHash,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			owner_timestamp: Math.floor(Date.now() / 1000), deleted_flag: false,
		};
		await ensureDialogKeysStream(dialogHash).ready;
		await ingest([{
			type: 'insert', syncMetadata: { relation: 'dialog_keys' },
			modified: { ...keyFields, sign_b64: signFields(keyFields as never, alice.sign.secretKey) },
		}], alice.sign.secretKey);

		// ---- 3. Alice sends; Bob unwraps her key from the shape and reads ----
		const m1 = await sendDialogMessage(alice, dialogHash, aliceKey,
			[{ kind: 'text', text: 'Скинь, пожалуйста, схему' }], {});

		const keyRow = (await waitRows('dialog_keys', `dialog_hash='${dialogHash}'`, (r) => r.length >= 1))[0];
		const bobsViewOfAliceKey = await DialogCrypto.unwrapSenderMsgKey(
			bob.kem.secretKey, keyRow.peer_kem_wrap_key_b64, keyRow.peer_wrapped_msg_key_b64);

		const m1row = (await waitRows('dialog_messages', `dialog_hash='${dialogHash}'`, (r) => r.length >= 1))[0];
		const m1text = contentToText(decodeContent(
			await DialogCrypto.decryptContent(bobsViewOfAliceKey, m1row.content_b64)));
		expect(m1text).toBe('Скинь, пожалуйста, схему');

		expect(m1.sendResult.results).toMatchObject([{ status: 'ok' }]);
		expect(m1.sendResult.txids.length).toBe(1);
		const acceptedM1 = await getAccepted('dialog_messages', m1.message_id, alice.userHash);
		expect(acceptedM1?.sign_hash).toBe(m1.sign_hash);
		expect(acceptedM1?.message_id).toBe(m1.message_id);

		const replayOutboxId = await enqueue([m1.mutation], alice.userHash);
		if (!replayOutboxId) throw new Error('replay setup: durable outbox unavailable');
		const drainResult = await drainOutbox(
			alice.userHash,
			(queued) => sendMutationsWithRetry(queued, alice.sign.secretKey, { retries: 1 }),
			reconcileAccepted
		);
		expect(drainResult.dropped).toBe(0);
		expect(drainResult.sent).toBe(1);
		expect(drainResult.remaining).toBe(0);
		const acceptedAfterReplay = await getAccepted('dialog_messages', m1.message_id, alice.userHash);
		expect(acceptedAfterReplay?.sign_hash).toBe(m1.sign_hash);

		// ---- 4. Bob's receive side admits through the gate ----
		const gate = createDialogGate({
			resolveSignPkey: async (h) => {
				const row = (await shapeRows('user_cards', `user_hash='${h}'`))[0];
				if (!row) return null;
				const v = verifyUserCard(row as never);
				return v.status === 'verified' ? v.card.signPkeyB64 : null;
			},
			decryptRefs: async (row) => {
				try {
					const json = await DialogCrypto.decryptContent(bobsViewOfAliceKey, row.refs_map_b64);
					return json ? JSON.parse(json) : {};
				} catch { return 'no_key'; }
			},
		});
		const verdict = await gate.admit(m1row as never);
		expect(verdict.status).toBe('verified');

		// ---- 5. Bob replies with a quote (his own key, wrapped for Alice) ----
		const bobKey = DialogCrypto.deriveSenderMsgKey(
			bob.sign.secretKey, bob.kem.secretKey, bob.contactSkey, alice.userHash);
		const wrappedForAlice = await DialogCrypto.wrapSenderMsgKey(bobKey, alice.kem.publicKey);
		const bobKeyFields = {
			dialog_hash: dialogHash, sender_hash: bob.userHash, peer_hash: alice.userHash,
			peer_kem_wrap_key_b64: wrappedForAlice.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrappedForAlice.peerWrappedMsgKeyB64,
			owner_timestamp: Math.floor(Date.now() / 1000), deleted_flag: false,
		};
		await ensureDialogKeysStream(dialogHash).ready;
		await ingest([{
			type: 'insert', syncMetadata: { relation: 'dialog_keys' },
			modified: { ...bobKeyFields, sign_b64: signFields(bobKeyFields as never, bob.sign.secretKey) },
		}], bob.sign.secretKey);

		const reply = await sendDialogMessage(bob, dialogHash, bobKey, [
			{ kind: 'quote', authorHash: alice.userHash, messageId: m1.message_id, signHash: m1.sign_hash,
				snapshot: [{ kind: 'text', text: m1text }] },
			{ kind: 'text', text: 'Уже в очереди, вечером будет' },
		], { [m1.message_id]: m1.sign_hash });

		// Alice reads the reply and sees the intact quote snapshot
		const aliceUnwrap = await DialogCrypto.unwrapSenderMsgKey(
			alice.kem.secretKey, wrappedForAlice.peerKemWrapKeyB64, wrappedForAlice.peerWrappedMsgKeyB64);
		console.log('step: reply visible?');
		const replyRows = await waitRows('dialog_messages', `dialog_hash='${dialogHash}'`,
			(rs) => rs.some((r) => r.message_id === reply.message_id));
		const replyRow = replyRows.find((r) => r.message_id === reply.message_id)!;
		const replyParts = decodeContent(await DialogCrypto.decryptContent(aliceUnwrap, replyRow.content_b64));
		expect(replyParts[0]).toMatchObject({ kind: 'quote', messageId: m1.message_id });
		expect(contentToText((replyParts[0] as { snapshot: ContentPart[] }).snapshot)).toBe(m1text);

		// and the gate admits it with its causal ref resolved
		const gateVerdict2 = await gate.admit(replyRow as never);
		// This gate decrypts refs with Alice's sender key, so Bob's refs map is
		// unreadable to it — the honest verdict is verified-but-unplaced.
		expect(gateVerdict2).toMatchObject({ status: 'verified', dagVerified: false });

		// ---- 6. Alice edits her message; the version chain holds ----
		const edited = await sendDialogMessage(alice, dialogHash, aliceKey,
			[{ kind: 'text', text: 'Скинь схему и акт' }],
			{ [reply.message_id]: reply.sign_hash },
			{ message_id: m1.message_id, parent_sign_hash: m1.sign_hash,
				owner_timestamp: m1.owner_timestamp + 1 });
		console.log('step: edited tip visible?');
		const tip = (await waitRows('dialog_messages', `message_id='${m1.message_id}'`,
			(rs) => rs.some((r) => r.parent_sign_hash === m1.sign_hash)))
			.find((r) => r.parent_sign_hash === m1.sign_hash)!;
		expect(tip.parent_sign_hash).toBe(m1.sign_hash);
		expect(deriveSignHash('dms_', tip.sign_b64)).toBe(edited.sign_hash);

		// ---- 7. Alice sends a file; Bob downloads it byte-identical ----
		const fileBytes = new Uint8Array(150_000).map((_, i) => (i * 17 + 3) % 253);
		const up = await uploadFile({
			bytes: fileBytes, uploaderHash: alice.userHash, signSkey: alice.sign.secretKey,
			...prepareUpload(uuidv7()),
		});
		await sendDialogMessage(alice, dialogHash, aliceKey, [
			{ kind: 'file', name: 'scheme.bin', size: fileBytes.length, mimeType: 'application/octet-stream',
				createdAt: Math.floor(Date.now() / 1000), fileId: up.fileId, encSecretB64: up.encSecretB64 },
			{ kind: 'text', text: 'вот схема' },
		], { [reply.message_id]: reply.sign_hash });

		console.log('step: 3 messages visible?');
		const fileMsg = (await waitRows('dialog_messages', `dialog_hash='${dialogHash}'`, (rs) => rs.length >= 3))
			.map((r) => ({ r, parts: null as ContentPart[] | null }));
		let filePart: ContentPart | undefined;
		for (const fm of fileMsg) {
			try {
				const parts = decodeContent(await DialogCrypto.decryptContent(bobsViewOfAliceKey, fm.r.content_b64));
				filePart = parts.find((p) => p.kind === 'file') ?? filePart;
			} catch { /* bob's own rows decrypt with his key; skip */ }
		}
		expect(filePart).toBeTruthy();
		const downloaded = await downloadFile({
			fileId: (filePart as { fileId: string }).fileId,
			encSecretB64: (filePart as { encSecretB64: string }).encSecretB64,
		});
		expect(bytesToHex(sha3_512(downloaded))).toBe(bytesToHex(sha3_512(fileBytes)));

		// ---- 8. Alice deletes her edited message: a signed tombstone ----
		const tomb = await sendDialogMessage(alice, dialogHash, aliceKey, [], { [reply.message_id]: reply.sign_hash },
			{ message_id: m1.message_id, parent_sign_hash: edited.sign_hash,
				owner_timestamp: edited.owner_timestamp + 1, deleted_flag: true, content: null });
		const tombRow = (await waitRows('dialog_messages', `message_id='${m1.message_id}'`,
			(rs) => rs.some((r) => String(r.deleted_flag) === 'true')))
			.find((r) => String(r.deleted_flag) === 'true')!;
		expect(tombRow.content_b64 ?? '').toBe('');
		console.log('tombstone accepted:', tomb.sign_hash.slice(0, 16));

		console.log('E2E OK:', {
			dialog: dialogHash.slice(0, 16) + '…',
			messages: (await shapeRows('dialog_messages', `dialog_hash='${dialogHash}'`)).length,
			file: up.fileId,
		});
}
