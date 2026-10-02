import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';

type Row = Record<string, unknown>;

export interface TestIdentity {
	userHash: string;
	signPkeyB64: string;
	signSkey: Uint8Array;
	kemSkey: Uint8Array;
	contactSk: Uint8Array;
	card: Row;
	vault: { sign_skey: string; crypt_skey: string; evm_skey: string };
}

export function makeTestIdentity(seed: number, name = `user-${seed}`, ownerTimestamp = 1_700_000_000): TestIdentity {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
	const card: Row = {
		user_hash: 'u_' + bytesToHex(sha3_512(sign.publicKey)),
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name,
		deleted_flag: false,
		owner_timestamp: ownerTimestamp,
	};
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return {
		userHash: card.user_hash as string,
		signPkeyB64: card.sign_pkey as string,
		signSkey: sign.secretKey,
		kemSkey: kem.secretKey,
		contactSk,
		card,
		vault: { sign_skey: toBase64(sign.secretKey), crypt_skey: toBase64(kem.secretKey), evm_skey: bytesToHex(contactSk) },
	};
}

export function resignedCard(identity: TestIdentity, changes: Row): Row {
	const { sign_b64: _old, ...fields } = { ...identity.card, ...changes };
	void _old;
	return { ...fields, sign_b64: signFields(fields as never, identity.signSkey) };
}

export function signRow(author: TestIdentity, fields: Row, signHashPrefix?: string): Row {
	const { sign_b64: _a, sign_hash: _b, ...signable } = fields;
	void _a; void _b;
	const sign_b64 = signFields(signable as never, author.signSkey);
	return { ...signable, sign_b64, ...(signHashPrefix ? { sign_hash: deriveSignHash(signHashPrefix, sign_b64) } : {}) };
}

export function signedDialogKeyRow(author: TestIdentity, fields: Partial<Row> & { dialog_hash: string; peer_hash: string }): Row {
	return signRow(author, {
		sender_hash: author.userHash,
		peer_kem_wrap_key_b64: toBase64(new Uint8Array([1])),
		peer_wrapped_msg_key_b64: toBase64(new Uint8Array([2])),
		owner_timestamp: 1_700_000_000,
		deleted_flag: false,
		...fields,
	});
}

export function signedStorageRow(author: TestIdentity, fields: Partial<Row> & { uuid: string }): Row {
	return signRow(author, {
		user_hash: author.userHash,
		value_b64: toBase64(new Uint8Array([1])),
		deleted_flag: false,
		parent_sign_hash: null,
		owner_timestamp: 1_700_000_000,
		...fields,
	}, 'uss_');
}
