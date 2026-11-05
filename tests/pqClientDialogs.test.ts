// @buckitup/pq-client/dialogs: the parts the conformance vectors do not pin.
// dialog_hash, reaction and receipt hashes and HKDF are checked against the
// backend's bytes in pqConformance.test.ts (through DialogCrypto, which calls
// this module); here: the message-key derivation as pq_dialogs specifies it,
// key wrapping with real ML-KEM-1024 keys, and content sealing.
import { describe, it, expect } from 'vitest';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
	decodeColumn,
	decryptContent,
	deriveSenderMsgKey,
	dialogHash,
	encryptContent,
	unwrapSenderMsgKey,
	wrapSenderMsgKey,
} from '@buckitup/pq-client/dialogs';
import { DialogCrypto } from '@/libs/DialogCrypto';

const utf8 = (s: string) => new TextEncoder().encode(s);
const unpad = (b64: string) => b64.replace(/=+$/, '');
const pgHex = (b64: string) => '\\x' + bytesToHex(decodeColumn(b64));

const ann = { sign: ml_dsa87.keygen(randomBytes(32)), crypt: ml_kem1024.keygen(randomBytes(64)), hash: 'u_' + 'a'.repeat(128) };
const bob = { crypt: ml_kem1024.keygen(randomBytes(64)), hash: 'u_' + 'b'.repeat(128) };

describe('@buckitup/pq-client dialogs', () => {
	it('derives sender_msg_key exactly as pq_dialogs § Key derivation writes it', () => {
		// IKM = sign_skey || crypt_skey || peer_user_hash; PRK = HMAC(salt, IKM); key = HMAC(PRK, "dialog-mk" || 0x01)
		const ikm = new Uint8Array([...ann.sign.secretKey, ...ann.crypt.secretKey, ...utf8(bob.hash)]);
		const prk = hmac(sha3_256, utf8('buckitup/dialog-mk/v1'), ikm);
		const expected = hmac(sha3_256, prk, new Uint8Array([...utf8('dialog-mk'), 0x01]));
		expect(bytesToHex(deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, bob.hash))).toBe(bytesToHex(expected));
	});

	it('takes no third key: the app\'s derivation with evm_skey gives another key until it follows the spec', () => {
		const spec = deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, bob.hash);
		const withEvm = DialogCrypto.deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, randomBytes(32), bob.hash);
		expect(bytesToHex(withEvm)).not.toBe(bytesToHex(spec));
		// The same HKDF otherwise: with nothing in the third slot the two agree.
		expect(bytesToHex(DialogCrypto.deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, new Uint8Array(0), bob.hash))).toBe(bytesToHex(spec));
	});

	it('wraps a key for the peer, who alone unwraps it — from a written row, a shape row or a Postgres hex value', async () => {
		const key = deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, bob.hash);
		const row = await wrapSenderMsgKey(key, bob.crypt.publicKey);
		for (const [kem, wrapped] of [
			[row.peer_kem_wrap_key_b64, row.peer_wrapped_msg_key_b64],
			[unpad(row.peer_kem_wrap_key_b64), unpad(row.peer_wrapped_msg_key_b64)],
			[pgHex(row.peer_kem_wrap_key_b64), pgHex(row.peer_wrapped_msg_key_b64)],
		]) {
			expect(bytesToHex(await unwrapSenderMsgKey(bob.crypt.secretKey, kem, wrapped))).toBe(bytesToHex(key));
		}
		await expect(unwrapSenderMsgKey(ann.crypt.secretKey, row.peer_kem_wrap_key_b64, row.peer_wrapped_msg_key_b64)).rejects.toThrow();
	});

	it('seals content under the key, opens it from a shape row, and reads a deleted message as empty', async () => {
		const key = deriveSenderMsgKey(ann.sign.secretKey, ann.crypt.secretKey, bob.hash);
		const sealed = await encryptContent(key, '{"text":"привет"}');
		expect(await decryptContent(key, sealed)).toBe('{"text":"привет"}');
		expect(await decryptContent(key, unpad(sealed))).toBe('{"text":"привет"}');
		expect(await encryptContent(key, 'x')).not.toBe(await encryptContent(key, 'x')); // a fresh nonce each time
		await expect(decryptContent(randomBytes(32), sealed)).rejects.toThrow();
		expect(await decryptContent(key, '')).toBe('');
		expect(await decryptContent(key, null)).toBe('');
	});

	// Wrapping and sealing are symmetric, so a round trip passes whatever bytes
	// they use. These rows were made by this module and open with the app's
	// implementation it replaced; a change to the wrap-key derivation, the nonce
	// layout or the cipher stops them opening.
	it('opens rows written before: the wrap-key derivation and the content layout are pinned', async () => {
		const kp = ml_kem1024.keygen(new Uint8Array(64).map((_, i) => i));
		const key = await unwrapSenderMsgKey(kp.secretKey,
			"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");
		expect(bytesToHex(key)).toBe("c8c7c6c5c4c3c2c1c0bfbebdbcbbbab9b8b7b6b5b4b3b2b1b0afaeadacabaaa9");
		expect(await decryptContent(key, "HdozM68otFe3+dWcEO1Dr3jgKdgiyn46IiRXCZwk0aPmqtOrlOgvkZCNzgjw")).toBe('{"text":"golden"}');
	});

	it('names one dialog the same from either side', () => {
		expect(dialogHash(ann.hash, bob.hash)).toBe(dialogHash(bob.hash, ann.hash));
		expect(dialogHash(ann.hash, bob.hash)).toMatch(/^di_[0-9a-f]{128}$/);
	});
});
