import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import type { DialogRecordFields } from '@/utils/db/tanstack/dialogQueue';
import type { ApiMutation } from '@/api/client';
import { modifiedOf } from '../testHelpers';

type RecordWithExtras = DialogRecordFields & Record<string, unknown>;

const SECURITY_TEST_MESSAGE_CANARY = 'SECURITY_TEST_MESSAGE_CANARY_7f91c2';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';

const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(21)).secretKey;

async function freshQueue() {
	vi.resetModules();
	const q = await import('@/utils/db/tanstack/dialogQueue');
	await q.ensureRehydrated();
	return q;
}

describe('buildDialogMutation — outgoing payload contains only protocol fields', () => {
	it('a dialog_messages mutation carries content_b64 as given (ciphertext, in the real flow) and nothing beyond the documented protocol field allowlist', async () => {
		const q = await freshQueue();
		const record = {
			message_id: 'dmsg_net_1',
			dialog_hash: 'di_' + 'a'.repeat(128),
			sender_hash: 'u_a',
			content_b64: 'ciphertext-blob-not-plaintext',
			deleted_flag: false,
			refs_map_b64: null,
			parent_sign_hash: null,
			owner_timestamp: 100,
		};

		const { mutation } = q.buildDialogMutation('dialog_messages', record, 'insert', signSkey);

		expect(mutation.syncMetadata.relation).toBe('dialog_messages');
		expect(mutation.type).toBe('insert');
		const payload = modifiedOf(mutation);
		expect(payload.content_b64).toBe('ciphertext-blob-not-plaintext');
		expect(JSON.stringify(payload)).not.toContain(SECURITY_TEST_MESSAGE_CANARY);

		const allowed = new Set(['message_id', 'dialog_hash', 'sender_hash', 'content_b64', 'deleted_flag', 'refs_map_b64', 'parent_sign_hash', 'owner_timestamp', 'sign_b64', 'sign_hash']);
		for (const key of Object.keys(payload)) {
			expect(allowed.has(key)).toBe(true);
		}
	});

	it('queue/cache-only metadata (ownerUserHash, __awaitingEcho, __ignoreEchoSignHash, revision, sentSnapshot, sentRevision, status, lastError) never appears in the built mutation payload', async () => {
		const q = await freshQueue();
		const contaminated: RecordWithExtras = {
			message_id: 'dmsg_net_2',
			dialog_hash: 'di_' + 'b'.repeat(128),
			sender_hash: 'u_a',
			content_b64: 'c',
			deleted_flag: false,
			owner_timestamp: 100,
			ownerUserHash: 'u_a',
			__awaitingEcho: true,
			__ignoreEchoSignHash: 'dms_' + 'a'.repeat(128),
			revision: 7,
			sentSnapshot: { some: 'snapshot' },
			sentRevision: 6,
			status: 'pending',
			lastError: 'boom',
		};

		const { mutation } = q.buildDialogMutation('dialog_messages', contaminated, 'insert', signSkey);
		const payload = modifiedOf(mutation);

		for (const forbidden of ['ownerUserHash', '__awaitingEcho', '__ignoreEchoSignHash', 'revision', 'sentSnapshot', 'sentRevision', 'status', 'lastError']) {
			expect(forbidden in payload).toBe(false);
		}
	});

	it('a dialog_message_reactions mutation carries type_b64 but never a plaintext "type" or "emoji" field', async () => {
		const q = await freshQueue();
		const record = {
			reaction_hash: 'dmr_net_1',
			dialog_hash: 'di_' + 'c'.repeat(128),
			message_id: 'dmsg_x',
			message_sign_hash: 'dms_' + 'a'.repeat(128),
			reactor_hash: 'u_a',
			type_b64: 'ciphertext-emoji-blob',
			deleted_flag: false,
			owner_timestamp: 100,
		};

		const { mutation } = q.buildDialogMutation('dialog_message_reactions', record, 'insert', signSkey);
		const payload = modifiedOf(mutation);

		expect(payload.type_b64).toBe('ciphertext-emoji-blob');
		expect('type' in payload).toBe(false);
		expect('emoji' in payload).toBe(false);
	});

	it('a dialog_keys mutation carries only the wrapped-key fields, never a raw key field', async () => {
		const q = await freshQueue();
		const record: RecordWithExtras = {
			dialog_hash: 'di_' + 'd'.repeat(128),
			sender_hash: 'u_a',
			peer_hash: 'u_b',
			peer_kem_wrap_key_b64: 'wrap-blob',
			peer_wrapped_msg_key_b64: 'wrapped-msg-key-blob',
			owner_timestamp: 100,
			deleted_flag: false,
			senderMsgKey: 'RAW_KEY_MATERIAL_SHOULD_NOT_LEAK',
		};

		const { mutation } = q.buildDialogMutation('dialog_keys', record, 'insert', signSkey);
		const payload = modifiedOf(mutation);

		expect(payload.peer_kem_wrap_key_b64).toBe('wrap-blob');
		expect(payload.peer_wrapped_msg_key_b64).toBe('wrapped-msg-key-blob');
		expect('senderMsgKey' in payload).toBe(false);
		expect(JSON.stringify(payload)).not.toContain('RAW_KEY_MATERIAL_SHOULD_NOT_LEAK');
	});
});

describe('createGenericMutation — signing/mutation integrity (no ciphertext-signature snapshots)', () => {
	it('produces a sign_b64 and a sign_hash deterministically derived from it, in the dms_<hex> shape', async () => {
		const { api } = await import('@/api/client');
		const mutation = api.createGenericMutation('dialog_messages', { message_id: 'dmsg_x', content_b64: 'c', deleted_flag: false }, signSkey, 'insert');

		const changes = modifiedOf(mutation);
		expect(typeof changes.sign_b64).toBe('string');
		expect(changes.sign_b64).toBeTruthy();
		expect(changes.sign_hash).toMatch(/^dms_[0-9a-f]{128}$/);
	});

	it('sign_hash is exactly sha3_512(decode(sign_b64)) hex-encoded with the dms_ prefix', async () => {
		const { api } = await import('@/api/client');
		const row = { message_id: 'dmsg_x', content_b64: 'c', deleted_flag: false };
		const mutation = api.createGenericMutation('dialog_messages', row, signSkey, 'insert');

		const changes = modifiedOf(mutation);
		expect(changes.sign_b64).toBeTruthy();
		const signBytes = Uint8Array.from(atob(changes.sign_b64 as string), (c) => c.charCodeAt(0));
		const expectedSignHash = 'dms_' + bytesToHex(sha3_512(signBytes));
		expect(changes.sign_hash).toBe(expectedSignHash);
	});

	it('local-only fields (operation, changed_at, sign_b64, sign_hash, modified_columns, sent_to_server, created_at, updated_at) given on input are excluded from the signed/outgoing field set', async () => {
		const { api } = await import('@/api/client');
		const row = {
			message_id: 'dmsg_x',
			content_b64: 'c',
			deleted_flag: false,
			operation: 'update',
			changed_at: 123,
			modified_columns: ['content_b64'],
			sent_to_server: true,
			created_at: 1,
			updated_at: 2,
		};
		const mutation = api.createGenericMutation('dialog_messages', row, signSkey, 'insert');
		const changes = modifiedOf(mutation);

		for (const localOnly of ['operation', 'changed_at', 'modified_columns', 'sent_to_server', 'created_at', 'updated_at']) {
			expect(localOnly in changes).toBe(false);
		}
	});

	it('the mutation relation/table matches the relation argument for every dialog table', async () => {
		const { api } = await import('@/api/client');
		for (const relation of ['dialog_keys', 'dialog_messages', 'dialog_messages_versions', 'dialog_message_reactions', 'dialog_message_receipts']) {
			const mutation = api.createGenericMutation(relation, { a: 1 }, signSkey, 'insert');
			expect(mutation.syncMetadata.relation).toBe(relation);
		}
	});

	it('an "update" mutation carries only the documented CHECK_FIELDS as its original, not the full record', async () => {
		const { api } = await import('@/api/client');
		const row = { message_id: 'dmsg_x', dialog_hash: 'di_x', sender_hash: 'u_a', content_b64: 'new-content', secret_internal: 'nope' };
		const mutation = api.createGenericMutation('dialog_messages', row, signSkey, 'update');

		expect(mutation.type).toBe('update');
		expect(mutation.original).toEqual({ message_id: 'dmsg_x', sender_hash: 'u_a', dialog_hash: 'di_x' });
		expect('secret_internal' in (mutation.original as object)).toBe(false);
	});
});

describe('flushPendingDialogChanges — the actual HTTP request body sent over the wire', () => {
	it('the JSON body POSTed to /ingest_each contains the built mutations and an auth block, and never any queue-internal field', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		await q.putPendingDialog(
			'dialog_messages',
			{ message_id: 'dmsg_wire_1', dialog_hash: 'di_' + 'e'.repeat(128), sender_hash: 'u_a', content_b64: 'ciphertext-on-the-wire', deleted_flag: false, owner_timestamp: 100 },
			'u_a'
		);

		interface IngestEachBody {
			auth: { challenge_id: string; signature: string };
			mutations: ApiMutation[];
		}
		let capturedBody: IngestEachBody | null = null;
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			if (url.includes('/challenge')) {
				return { ok: true, json: async () => ({ challenge: 'chal', challenge_id: 'cid' }) } as unknown as Response;
			}
			if (url.includes('/ingest_each')) {
				const body = typeof init?.body === 'string' ? init.body : '';
				capturedBody = JSON.parse(body) as IngestEachBody;
				const results = capturedBody.mutations.map((_, i) => ({ index: i, status: 'ok' }));
				return { ok: true, json: async () => ({ results }) } as unknown as Response;
			}
			throw new Error(`unexpected fetch to ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(capturedBody).toBeTruthy();
		const body = capturedBody!;
		expect(body.auth.challenge_id).toBe('cid');
		expect(typeof body.auth.signature).toBe('string');
		expect(body.mutations.length).toBeGreaterThan(0);

		const bodyText = JSON.stringify(capturedBody);
		expect(bodyText).not.toContain(SECURITY_TEST_MESSAGE_CANARY);
		for (const forbidden of ['ownerUserHash', '__awaitingEcho', '__ignoreEchoSignHash', '"revision"', 'sentSnapshot', 'sentRevision', '"status"', 'lastError']) {
			expect(bodyText).not.toContain(forbidden);
		}

		vi.unstubAllGlobals();
	});
});
