// Signature-level verification of replicated dialog rows.
//
// The server verified these on ingest, but peer sync bypasses PoP and a
// replicated row must prove itself to this client too
// (invariants/02_integrity.md). Pure functions: the caller resolves the
// sender's verified sign_pkey (through verifyUserCard) and hands it in.

import { verifyFields, deriveSignHash } from './signature';
import type {
	DialogMessageRow,
	DialogMessageVersionRow,
	DialogMessageReactionRow,
	DialogMessageReceiptRow,
} from '@/lib/data/types';

export type RowVerdict =
	| { status: 'ok' }
	| { status: 'invalid'; reason: 'missing_signature' | 'bad_signature' | 'sign_hash_mismatch' };

/**
 * dialog_messages / dialog_messages_versions carry a sign_hash column that is
 * derived from sign_b64, not covered by it. A row whose sign_hash lies about
 * its signature would poison every parent_sign_hash / message_sign_hash
 * reference pointing at it, so the derivation is checked, not trusted.
 */
export const verifyMessageRow = (
	row: DialogMessageRow | DialogMessageVersionRow,
	senderSignPkeyB64: string,
): RowVerdict => {
	if (!row.sign_b64) return { status: 'invalid', reason: 'missing_signature' };
	if (row.sign_hash && row.sign_hash !== deriveSignHash('dms_', row.sign_b64)) {
		return { status: 'invalid', reason: 'sign_hash_mismatch' };
	}
	if (!verifyFields(row as never, row.sign_b64, senderSignPkeyB64)) {
		return { status: 'invalid', reason: 'bad_signature' };
	}
	return { status: 'ok' };
};

/** Reactions and receipts have no sign_hash column — signature check only. */
export const verifySideRow = (
	row: DialogMessageReactionRow | DialogMessageReceiptRow,
	authorSignPkeyB64: string,
): RowVerdict => {
	if (!row.sign_b64) return { status: 'invalid', reason: 'missing_signature' };
	if (!verifyFields(row as never, row.sign_b64, authorSignPkeyB64)) {
		return { status: 'invalid', reason: 'bad_signature' };
	}
	return { status: 'ok' };
};
