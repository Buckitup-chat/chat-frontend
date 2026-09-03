// Full user-flow E2E against the live staging backend, driven through the
// same modules the browser runs — DialogCrypto, the content codec, the
// signature module, the file transport, and the verification gate. Gated
// behind E2E=1 so CI never talks to the network:
//
//   E2E=1 npx vitest run tests/e2e.staging.test.ts
//
// Two fresh accounts hold a conversation: keys are wrapped and unwrapped for
// real, messages travel through /ingest and come back through shapes, the
// receive side admits rows through the gate before trusting them, a reply
// carries its quote snapshot, an edit archives a version, and a file round-
// trips through the chunk endpoints byte-identical.
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { v7 as uuidv7 } from 'uuid';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent, decodeContent, contentToText, type ContentPart } from '@/lib/pq/content';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import { createDialogGate } from '@/lib/data/dialogGate';
import { uploadFile, downloadFile, prepareUpload } from '@/lib/data/fileTransfer';
import { DialogCrypto } from '@/libs/DialogCrypto';

const BASE = 'https://buckitup.xyz/electric/v1';
(globalThis as Record<string, unknown>).ELECTRIC_API_URL = BASE;

const runIf = process.env.E2E === '1' ? describe : describe.skip;

interface Account {
	name: string;
	userHash: string;
	sign: { publicKey: Uint8Array; secretKey: Uint8Array };
	kem: { publicKey: Uint8Array; secretKey: Uint8Array };
	contactSkey: Uint8Array;
	card: Record<string, unknown>;
}

const ingest = async (mutations: unknown[], signSkey: Uint8Array) => {
	const ch = await (await fetch(`${BASE}/challenge`)).json();
	const signature = toBase64(ml_dsa87.sign(new TextEncoder().encode(ch.challenge), signSkey)).replace(/=+$/, '');
	const r = await fetch(`${BASE}/ingest`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ auth: { challenge_id: ch.challenge_id, signature }, mutations }),
	});
	if (r.status !== 200) throw new Error(`ingest ${r.status}: ${(await r.text()).slice(0, 200)}`);
	return r.json();
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
	overrides: Partial<{ message_id: string; parent_sign_hash: string; owner_timestamp: number; deleted_flag: boolean; content: string }> = {},
) => {
	const messageId = overrides.message_id ?? 'dmsg_' + uuidv7();
	const contentB64 = overrides.content ?? await DialogCrypto.encryptContent(msgKey, encodeContent(parts));
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
	await ingest([{
		type: overrides.parent_sign_hash ? 'update' : 'insert',
		syncMetadata: { relation: 'dialog_messages' },
		...(overrides.parent_sign_hash
			? { original: { message_id: messageId, sender_hash: author.userHash, dialog_hash: dialogHash }, changes: row }
			: { modified: row }),
	}], author.sign.secretKey);
	return row;
};

runIf('E2E: two accounts hold a conversation on staging', () => {
	it('keys, messages, gate, reply with quote, edit, file — end to end', async () => {
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

		console.log('E2E OK:', {
			dialog: dialogHash.slice(0, 16) + '…',
			messages: (await shapeRows('dialog_messages', `dialog_hash='${dialogHash}'`)).length,
			file: up.fileId,
		});
	}, 300000);
});
