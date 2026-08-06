import { describe, it, expect } from 'vitest';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { bytesToHex } from '@noble/hashes/utils';
import { makeKey, THUMBS_UP, THUMBS_DOWN, THUMBS_UP_WITH_SKIN_TONE, FAMILY_SEQUENCE } from './dialogCrypto.fixtures';

describe('DialogCrypto.computeDialogHash', () => {
	it('is symmetric: same hash regardless of argument order', () => {
		const a = 'uh_alice';
		const b = 'uh_bob';
		expect(DialogCrypto.computeDialogHash(a, b)).toBe(DialogCrypto.computeDialogHash(b, a));
	});

	it('produces the di_ prefix and a 128-char sha3-512 hex body', () => {
		const hash = DialogCrypto.computeDialogHash('uh_alice', 'uh_bob');
		expect(hash).toMatch(/^di_[0-9a-f]{128}$/);
	});

	it('differs for different user pairs', () => {
		const ab = DialogCrypto.computeDialogHash('uh_alice', 'uh_bob');
		const ac = DialogCrypto.computeDialogHash('uh_alice', 'uh_carol');
		expect(ab).not.toBe(ac);
	});

	it('is deterministic (stable across calls)', () => {
		const first = DialogCrypto.computeDialogHash('uh_x', 'uh_y');
		const second = DialogCrypto.computeDialogHash('uh_x', 'uh_y');
		expect(first).toBe(second);
	});
});

describe('DialogCrypto.deriveSenderMsgKey', () => {
	const signSkey = makeKey(1);
	const kemSkey = makeKey(2);
	// dialogs.store.js currently passes `evm_skey` (a hex string) into this
	// parameter even though DialogCrypto names it `contactSkey` — these tests
	// pin today's actual contract, not the name in the source.
	const evmSkey = '3'.repeat(64); // 32 raw bytes as hex, matching bytesToHex(evmPrivKey) in EncryptionManagerPQ
	const peerUserHash = 'u_' + 'e'.repeat(128);

	it('is deterministic for identical arguments', () => {
		const a = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const b = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		expect(a).toEqual(b);
	});

	it('returns a 32-byte key', () => {
		const key = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(32);
	});

	it('changes when signSkey changes', () => {
		const a = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const b = DialogCrypto.deriveSenderMsgKey(makeKey(9), kemSkey, evmSkey, peerUserHash);
		expect(a).not.toEqual(b);
	});

	it('changes when kemSkey changes', () => {
		const a = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const b = DialogCrypto.deriveSenderMsgKey(signSkey, makeKey(9), evmSkey, peerUserHash);
		expect(a).not.toEqual(b);
	});

	it('changes when the third secret key (evmSkey, passed as contactSkey) changes', () => {
		const a = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const b = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, '9'.repeat(64), peerUserHash);
		expect(a).not.toEqual(b);
	});

	it('changes when peerUserHash changes', () => {
		const a = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const b = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, 'u_' + 'f'.repeat(128));
		expect(a).not.toEqual(b);
	});

	it('can be used as an AES key for an encryptContent/decryptContent round-trip', async () => {
		const key = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		const plaintext = JSON.stringify({ type: 'text', text: 'hello' });

		const contentB64 = await DialogCrypto.encryptContent(key, plaintext);
		const decrypted = await DialogCrypto.decryptContent(key, contentB64);

		expect(decrypted).toBe(plaintext);
	});

	it('matches the known-answer vector for the fixture inputs', () => {
		const key = DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, evmSkey, peerUserHash);
		expect(bytesToHex(key)).toBe('bcf792eedbb6ecb0a288d5b749e2c0c795128171dabce94a282b34b5ef474d9d');
	});
});

describe('DialogCrypto.computeReactionHash', () => {
	const key = makeKey(1);
	const messageId = 'dmsg_0000000000000000000000000';
	const reactorHash = 'u_' + 'a'.repeat(128);
	const emoji = THUMBS_UP;

	it('is deterministic for identical arguments', () => {
		const first = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		const second = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		expect(first).toBe(second);
	});

	it('changes when the message key changes', () => {
		const withKeyA = DialogCrypto.computeReactionHash(makeKey(1), messageId, reactorHash, emoji);
		const withKeyB = DialogCrypto.computeReactionHash(makeKey(2), messageId, reactorHash, emoji);
		expect(withKeyA).not.toBe(withKeyB);
	});

	it('changes when messageId changes', () => {
		const a = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		const b = DialogCrypto.computeReactionHash(key, 'dmsg_1111111111111111111111111', reactorHash, emoji);
		expect(a).not.toBe(b);
	});

	it('changes when reactorHash changes', () => {
		const a = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		const b = DialogCrypto.computeReactionHash(key, messageId, 'u_' + 'b'.repeat(128), emoji);
		expect(a).not.toBe(b);
	});

	it('changes when the emoji changes', () => {
		const a = DialogCrypto.computeReactionHash(key, messageId, reactorHash, THUMBS_UP);
		const b = DialogCrypto.computeReactionHash(key, messageId, reactorHash, THUMBS_DOWN);
		expect(a).not.toBe(b);
	});

	it('handles multi-codepoint unicode emoji stably', () => {
		// FAMILY_SEQUENCE: a ZWJ sequence. THUMBS_UP_WITH_SKIN_TONE: base + skin-tone modifier.
		const first = DialogCrypto.computeReactionHash(key, messageId, reactorHash, FAMILY_SEQUENCE);
		const second = DialogCrypto.computeReactionHash(key, messageId, reactorHash, FAMILY_SEQUENCE);
		expect(first).toBe(second);

		const skinToneHash = DialogCrypto.computeReactionHash(key, messageId, reactorHash, THUMBS_UP_WITH_SKIN_TONE);
		expect(skinToneHash).not.toBe(first);
	});

	it('produces the dmr_ prefix and a 128-char sha3-512 hex body', () => {
		const hash = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		expect(hash).toMatch(/^dmr_[0-9a-f]{128}$/);
	});

	it('matches the known-answer vector for the fixture inputs', () => {
		const hash = DialogCrypto.computeReactionHash(key, messageId, reactorHash, emoji);
		expect(hash).toBe(
			'dmr_8ff19b4da6fc495d22badf7d95ba77de630f4cf374352321bd8e61595ed165f3db65d3154ab12112c5f5ee477a78cc3215acb2fbdb95c46b48591f9222aef30e'
		);
	});
});

describe('DialogCrypto.computeReceiptHash', () => {
	const messageId = 'dmsg_0000000000000000000000000';
	const messageSignHash = 'dms_' + 'c'.repeat(128);
	const peerHash = 'u_' + 'd'.repeat(128);
	const type = 'read';

	it('is deterministic for identical arguments', () => {
		const first = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		const second = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		expect(first).toBe(second);
	});

	it('changes when messageId changes', () => {
		const a = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		const b = DialogCrypto.computeReceiptHash('dmsg_1111111111111111111111111', messageSignHash, peerHash, type);
		expect(a).not.toBe(b);
	});

	it('changes when messageSignHash changes', () => {
		const a = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		const b = DialogCrypto.computeReceiptHash(messageId, 'dms_' + 'e'.repeat(128), peerHash, type);
		expect(a).not.toBe(b);
	});

	it('changes when peerHash changes', () => {
		const a = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		const b = DialogCrypto.computeReceiptHash(messageId, messageSignHash, 'u_' + 'f'.repeat(128), type);
		expect(a).not.toBe(b);
	});

	it('changes when type changes', () => {
		const a = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, 'read');
		const b = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, 'delivered');
		expect(a).not.toBe(b);
	});

	it('produces the dmrc_ prefix and a 128-char sha3-512 hex body', () => {
		const hash = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		expect(hash).toMatch(/^dmrc_[0-9a-f]{128}$/);
	});

	it('matches the known-answer vector for the fixture inputs', () => {
		const hash = DialogCrypto.computeReceiptHash(messageId, messageSignHash, peerHash, type);
		expect(hash).toBe(
			'dmrc_534953c58851e14659983cdf5b33ce4ee4a58fed760709b69a0e77f227668743837b92fc17dc58630df1e6f317b4f8820b5e75703a9ffea25a307187471ee48e'
		);
	});
});
