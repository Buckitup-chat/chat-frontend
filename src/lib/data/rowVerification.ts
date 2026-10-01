import { verifyUserCard } from '@/lib/pq/verifyCard';
import { verifyMessageRow, verifySideRow } from '@/lib/pq/verifyDialogRow';
import { verifyFields, deriveSignHash } from '@/lib/pq/signature';
import { signableFields } from '@/lib/pq/schema';
import { VaultLockedError } from './keyCustody';
import { OWNER_FIELD } from './writeContracts';
import type {
	DialogMessageRow,
	DialogMessageReactionRow,
	DialogMessageReceiptRow,
	UserCardRow,
} from './types';

export type RowInvalidReason =
	| 'missing_signature'
	| 'missing_sign_hash'
	| 'sign_hash_mismatch'
	| 'bad_signature'
	| 'missing_fields'
	| 'missing_author'
	| 'hash_mismatch'
	| 'bad_cert';

export type RowVerification =
	| { status: 'verified' }
	| { status: 'invalid'; reason: RowInvalidReason }
	| { status: 'unsupported'; reason: 'no_local_verification' }
	| { status: 'unavailable'; reason: 'author_card_unavailable' | 'locked' };

export type SignPkeyResolver = (userHash: string) => Promise<string | null>;

export const SIGN_HASH_PREFIX: Record<string, string> = {
	user_storage: 'uss_',
	dialog_messages: 'dms_',
	dialog_messages_versions: 'dms_',
};

const VERIFIABLE = new Set([
	'user_cards',
	'user_storage',
	'dialog_keys',
	'dialog_messages',
	'dialog_messages_versions',
	'dialog_message_reactions',
	'dialog_message_receipts',
]);

const VERIFIED: RowVerification = { status: 'verified' };
const invalid = (reason: RowInvalidReason): RowVerification => ({ status: 'invalid', reason });

export const authorOf = (relation: string, row: Record<string, unknown>): string | null => {
	const field = OWNER_FIELD[relation];
	const value = field ? row[field] : undefined;
	return typeof value === 'string' && value ? value : null;
};

const verifyCardRow = (row: Record<string, unknown>): RowVerification => {
	const verdict = verifyUserCard(row as unknown as UserCardRow);
	if (verdict.status === 'verified') return VERIFIED;
	return invalid(verdict.reason);
};

const verifySignedFields = (relation: string, row: Record<string, unknown>, signPkey: string): RowVerification => {
	const signB64 = row.sign_b64;
	if (typeof signB64 !== 'string' || !signB64) return invalid('missing_signature');
	const prefix = SIGN_HASH_PREFIX[relation];
	if (prefix) {
		if (typeof row.sign_hash !== 'string' || !row.sign_hash) return invalid('missing_sign_hash');
		if (row.sign_hash !== deriveSignHash(prefix, signB64)) return invalid('sign_hash_mismatch');
	}
	const fields = signableFields(relation, row);
	if (!fields) return invalid('missing_fields');
	return verifyFields(fields as never, signB64, signPkey) ? VERIFIED : invalid('bad_signature');
};

export function verifyRowWithKey(relation: string, row: Record<string, unknown>, authorSignPkey: string): RowVerification {
	switch (relation) {
		case 'user_cards':
			return verifyCardRow(row);
		case 'dialog_messages':
		case 'dialog_messages_versions': {
			if (typeof row.sign_hash !== 'string' || !row.sign_hash) {
				return row.sign_b64 ? invalid('missing_sign_hash') : invalid('missing_signature');
			}
			const verdict = verifyMessageRow(row as unknown as DialogMessageRow, authorSignPkey);
			return verdict.status === 'ok' ? VERIFIED : invalid(verdict.reason);
		}
		case 'dialog_message_reactions':
		case 'dialog_message_receipts': {
			const verdict = verifySideRow(row as unknown as DialogMessageReactionRow | DialogMessageReceiptRow, authorSignPkey);
			return verdict.status === 'ok' ? VERIFIED : invalid(verdict.reason);
		}
		case 'user_storage':
		case 'dialog_keys':
			return verifySignedFields(relation, row, authorSignPkey);
		default:
			return { status: 'unsupported', reason: 'no_local_verification' };
	}
}

export async function verifyReplicatedRow(
	relation: string,
	row: Record<string, unknown>,
	resolveSignPkey: SignPkeyResolver,
): Promise<RowVerification> {
	if (!VERIFIABLE.has(relation)) return { status: 'unsupported', reason: 'no_local_verification' };
	if (relation === 'user_cards') return verifyCardRow(row);
	const author = authorOf(relation, row);
	if (!author) return invalid('missing_author');
	let signPkey: string | null;
	try {
		signPkey = await resolveSignPkey(author);
	} catch (e) {
		if (e instanceof VaultLockedError) return { status: 'unavailable', reason: 'locked' };
		throw e;
	}
	if (!signPkey) return { status: 'unavailable', reason: 'author_card_unavailable' };
	return verifyRowWithKey(relation, row, signPkey);
}
