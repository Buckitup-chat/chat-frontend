import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { toBytes } from '@buckitup/pq-client/signature';

/** What a backup holds — the object exportBackup builds and every restore
 * path (file, shares, device link, passkey) hands to importBackup. */
export interface BackupContents {
	identity: { user_hash: string; name?: string; [key: string]: unknown };
	keys: Record<string, unknown>;
}

/** The one place that decides whether parsed data is an account backup. */
export const parseBackupContents = (data: unknown): BackupContents => {
	const d = data as Partial<BackupContents> | null;
	if (!d?.identity?.user_hash || !d.keys || typeof d.keys !== 'object') {
		throw new Error('not an account backup');
	}
	return d as BackupContents;
};

export class BackupMismatchError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'BackupMismatchError';
	}
}

const REQUIRED_KEYS = ['sign_skey', 'crypt_skey', 'evm_skey', 'contact_skey'] as const;
const BINDING_CHALLENGE = new TextEncoder().encode('buckitup/backup/account-binding/v1');

export const assertBackupConsistent = ({ identity, keys }: BackupContents): void => {
	for (const name of REQUIRED_KEYS) {
		if (typeof keys[name] !== 'string' || !keys[name]) throw new BackupMismatchError(`The backup has no ${name}.`);
	}
	if (typeof identity.sign_pkey !== 'string' || !identity.sign_pkey) {
		throw new BackupMismatchError('The backup has no public signing key.');
	}
	let signPkey: Uint8Array;
	let signSkey: Uint8Array;
	try {
		signPkey = toBytes(identity.sign_pkey);
		signSkey = toBytes(keys.sign_skey as string);
	} catch {
		throw new BackupMismatchError('The backup\'s signing keys are not readable.');
	}
	if (identity.user_hash !== 'u_' + bytesToHex(sha3_512(signPkey))) {
		throw new BackupMismatchError('The backup\'s account does not match its public signing key.');
	}
	let binds = false;
	try {
		binds = ml_dsa87.verify(ml_dsa87.sign(BINDING_CHALLENGE, signSkey), BINDING_CHALLENGE, signPkey);
	} catch {
		binds = false;
	}
	if (!binds) throw new BackupMismatchError('The backup\'s secret signing key belongs to another account.');
};
