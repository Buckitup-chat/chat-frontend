import { verifyUserCard } from '@buckitup/pq-client/verifyCard';
import { verifyRow, SIGN_HASH_PREFIX } from '@buckitup/pq-client/rows';
import { VaultLockedError } from './keyCustody';
import { OWNER_FIELD } from './writeContracts';
import type { UserCardRow } from '@buckitup/pq-client/types';

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

export { SIGN_HASH_PREFIX };

const VERIFIABLE = new Set([
	'user_cards',
	'user_storage',
	'dialog_keys',
	'dialog_messages',
	'dialog_messages_versions',
	'dialog_message_reactions',
	'dialog_message_receipts',
	'files',
	'vouch_tokens',
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
	const verdict = verifyRow(relation, row, signPkey);
	return verdict.status === 'ok' ? VERIFIED : invalid(verdict.reason);
};

export function verifyRowWithKey(relation: string, row: Record<string, unknown>, authorSignPkey: string): RowVerification {
	switch (relation) {
		case 'user_cards':
			return verifyCardRow(row);
		case 'dialog_messages':
		case 'dialog_messages_versions':
		case 'dialog_message_reactions':
		case 'dialog_message_receipts':
		case 'user_storage':
		case 'dialog_keys':
		case 'files':
		case 'file_chunks':
		case 'vouch_tokens':
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
