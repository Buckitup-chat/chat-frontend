// Regressions for three confirmed write-path defects.
//
// Each of these had the same shape: a failure that looked like success. A
// signature compared as text, an accepted write whose read model never caught
// up, a durable retryable entry with nothing scheduled to retry it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toBase64 } from '@/lib/pq/signature';
import { assertFreshBase, markUnconfirmed, clearUnconfirmed, isUnconfirmed, StaleBaseError, _resetStaleBase } from '@/lib/data/staleBase';
import { scopeForRelation } from '@/lib/data/barrier';
import type { MutationLike } from '@/lib/data/confirm';

// 91 bytes: not a multiple of three, so base64 really does carry padding —
// the only case where the two spellings differ.
const SIG = new Uint8Array(Array.from({ length: 91 }, (_, i) => (i * 31 + 7) % 251));
const padded = toBase64(SIG);
const unpadded = padded.replace(/=+$/, '');

describe('defect 1: signature identity across encodings', () => {
	// The same bytes reach the client in several spellings: the shape endpoint
	// returns binary columns as base64 without padding, while the signed
	// payload is built with it. Comparing them as text calls an identical
	// signature different — and this comparison decides whether a durable
	// outbox entry may be dropped, so a false "not ours" strands the write.
	const MESSAGE_ID = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
	const DIALOG = 'di_' + 'a'.repeat(128);

	let remoteRow: Record<string, unknown> | undefined;
	let mutationAppliedOnServer: (m: MutationLike, opts?: { attempts?: number; delayMs?: number }) => Promise<boolean>;

	beforeEach(async () => {
		vi.resetModules();
		vi.doMock('@/lib/data/collections', () => ({
			getUserCardsCollection: () => ({ async preload() {}, get: () => undefined }),
			getUserStorageCollection: () => ({ async preload() {}, get: () => undefined }),
			getDialogCollections: () => ({
				keys: { async preload() {}, get: () => undefined },
				messages: { async preload() {}, get: () => remoteRow },
				reactions: { async preload() {}, get: () => undefined },
				receipts: { async preload() {}, get: () => undefined },
			}),
		}));
		({ mutationAppliedOnServer } = await import('@/lib/data/confirm'));
	});

	const mutation = (sign: string) => ({
		syncMetadata: { relation: 'dialog_messages' },
		modified: { message_id: MESSAGE_ID, dialog_hash: DIALOG, sign_b64: sign },
	});

	it('confirms our own mutation when the server row lost its padding', async () => {
		expect(unpadded).not.toBe(padded); // the spellings really do differ
		remoteRow = { message_id: MESSAGE_ID, sign_b64: unpadded };
		await expect(mutationAppliedOnServer(mutation(padded))).resolves.toBe(true);
	});

	it('still refuses a row carrying somebody else\'s signature', async () => {
		const other = toBase64(SIG.map((v, i) => (i === 5 ? v ^ 1 : v)));
		remoteRow = { message_id: MESSAGE_ID, sign_b64: other };
		await expect(mutationAppliedOnServer(mutation(padded), { attempts: 1 })).resolves.toBe(false);
	});

	it('an unreadable signature is never a confirmation', async () => {
		remoteRow = { message_id: MESSAGE_ID, sign_b64: '!!!not base64!!!' };
		await expect(mutationAppliedOnServer(mutation(padded), { attempts: 1 })).resolves.toBe(false);
	});
});

describe('defect 2: an accepted write whose shape never arrived', () => {
	beforeEach(() => _resetStaleBase());

	// Not a send failure — the server committed — but the read model is known
	// to be behind, so a chained write must refuse rather than sign against a
	// tip that may be a revision old.
	it('blocks a chained write in the affected scope only', () => {
		const dialog = 'dialog_messages|di_' + 'a'.repeat(128);
		const other = 'dialog_messages|di_' + 'b'.repeat(128);
		markUnconfirmed(dialog);

		expect(() => assertFreshBase(dialog)).toThrow(StaleBaseError);
		expect(() => assertFreshBase(other)).not.toThrow();
	});

	it('clears once the scope catches up', () => {
		const scope = 'user_storage|u_' + 'c'.repeat(128);
		markUnconfirmed(scope);
		expect(isUnconfirmed(scope)).toBe(true);
		clearUnconfirmed(scope);
		expect(() => assertFreshBase(scope)).not.toThrow();
	});

	// Staleness is per read scope: dialogs have their own shapes, and a
	// barrier that timed out in one says nothing about another.
	it('scopes are per dialog and per account', () => {
		const a = scopeForRelation('dialog_messages', { dialog_hash: 'di_a' });
		const b = scopeForRelation('dialog_messages', { dialog_hash: 'di_b' });
		expect(a).not.toBe(b);
		expect(scopeForRelation('user_storage', { user_hash: 'u_1' }))
			.not.toBe(scopeForRelation('user_storage', { user_hash: 'u_2' }));
		expect(scopeForRelation('user_cards', {})).toBe('user_cards');
	});
});
