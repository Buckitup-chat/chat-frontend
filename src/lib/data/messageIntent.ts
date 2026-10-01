import { getDialogCollections, getUserCardsCollection } from './collections';
import { readAcceptedEvidence } from './operationLifecycle';
import { verifyReplicatedRow } from './rowVerification';
import { getVerifiedSignPkey } from './cardRegistry';
import { readDialogRow } from './dialogCache';
import { readCachedCard } from './userCardsCache';
import { settled } from './shapeLink';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import { enqueueIntent } from './intents';
import { signAndDispatchIntent, type DialogIntentPayload, type MessageIntentPayload, type ReadyRowIntent } from './intentRecovery';
import type { SessionToken } from './outbox';
import { pinActiveSession, assertSessionUnchanged, SessionFencedError } from './sessionGuard';
import { VaultLockedError } from './keyCustody';
import { nextOwnerTimestamp } from './time';
import type { UserCardRow } from './types';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { decodeHexOrBase64 } from '@/libs/enigma';
import { encodeContent } from '@/lib/pq/content';

function decode(str: string, fieldName: string): Uint8Array {
	const result = decodeHexOrBase64(str);
	if (!result) throw new Error(`${fieldName} is empty`);
	return result;
}

export { SessionFencedError, pinActiveSession, assertSessionUnchanged };


async function vaultKeys() {
	let em: InstanceType<typeof EncryptionManagerPQ> | null;
	try {
		em = EncryptionManagerPQ.getInstance() as unknown as InstanceType<typeof EncryptionManagerPQ>;
	} catch (e) {
		throw new VaultLockedError(String((e as Error)?.message ?? e));
	}
	if (!em) throw new VaultLockedError('vault instance not available');
	try {
		return await em.exportVaultKeys();
	} catch (e) {
		throw new VaultLockedError(String((e as Error)?.message ?? e));
	}
}

async function signSkeyBytes(): Promise<Uint8Array> {
	const keys = await vaultKeys();
	return decode(keys.sign_skey, 'sign_skey');
}

export async function ownSenderMsgKey(peerHash: string): Promise<Uint8Array> {
	const keys = await vaultKeys();
	const signSkey = decode(keys.sign_skey, 'sign_skey');
	const kemSkey = decode(keys.crypt_skey, 'crypt_skey');
	return DialogCrypto.deriveSenderMsgKey(signSkey, kemSkey, keys.evm_skey, peerHash);
}

const pendingKeyPublish = new Map<string, Promise<void>>();

export async function ensureOwnDialogKeyPublished(
	peerHash: string,
	dialogHash: string,
	myHash: string,
	token: SessionToken
): Promise<void> {
	const guardKey = `${dialogHash}|${myHash}`;
	const inFlight = pendingKeyPublish.get(guardKey);
	if (inFlight) return inFlight;

	const promise = ensureOwnDialogKeyPublishedUnguarded(peerHash, dialogHash, myHash, token);
	pendingKeyPublish.set(guardKey, promise);
	try {
		await promise;
	} finally {
		if (pendingKeyPublish.get(guardKey) === promise) pendingKeyPublish.delete(guardKey);
	}
}

async function ensureOwnDialogKeyPublishedUnguarded(
	peerHash: string,
	dialogHash: string,
	myHash: string,
	token: SessionToken
): Promise<void> {
	if (token.userHash !== myHash) {
		throw new SessionFencedError(
			`ensureOwnDialogKeyPublished: token account (${token.userHash}) does not match the row's own owner (${myHash})`
		);
	}
	const keyId = `${dialogHash}|${myHash}`;
	const dialogColls = getDialogCollections(dialogHash);
	const keysState = await settled(dialogColls.keys as unknown as Parameters<typeof settled>[0]);
	const myKeyRow = (dialogColls.keys.get(keyId)
		?? (keysState.state === 'failed' ? await readDialogRow('dialog_keys', keyId) : null)) as Record<string, unknown> | null | undefined;
	const rowVerification = myKeyRow ? await verifyReplicatedRow('dialog_keys', myKeyRow, getVerifiedSignPkey) : null;
	if (myKeyRow && rowVerification?.status === 'verified' && !myKeyRow.deleted_flag) return;

	const accepted = await readAcceptedEvidence('dialog_keys', keyId, myHash);
	switch (accepted.kind) {
		case 'present':
			if (!accepted.row.deleted_flag) return;
			break;
		case 'missing': break;
		case 'locked': throw new VaultLockedError('the accepted dialog key cannot be read while the account is locked');
		case 'corrupt':
		case 'unavailable':
			throw new Error(`The accepted dialog key cannot be read (${accepted.failure}) — the message waits for recovery`);
	}
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:afterAcceptedSnapshotLookup');
	if (myKeyRow && rowVerification?.status !== 'verified') {
		throw new Error(`The dialog key row cannot be verified (${rowVerification?.status}) — the message waits for recovery`);
	}
	if (keysState.state === 'failed') {
		throw new Error(`Dialog keys are not readable yet — the message waits for recovery: ${String((keysState.error as Error)?.message ?? keysState.error)}`, { cause: keysState.error });
	}

	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:beforeVaultAccess');
	const senderMsgKey = await ownSenderMsgKey(peerHash);
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:afterVaultExport');
	const cards = getUserCardsCollection();
	const cardsState = await settled(cards as unknown as Parameters<typeof settled>[0]);
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:afterPeerCardPreload');
	const cachedPeerCard = cardsState.state === 'failed' && !cards.get(peerHash) ? await readCachedCard(peerHash) : null;
	const peerCard = [cards.get(peerHash) as UserCardRow | undefined, cachedPeerCard]
		.find((card) => card && verifyUserCard(card).status === 'verified') ?? null;
	if (!peerCard || !peerCard.crypt_pkey) {
		throw new Error('Peer crypt_pkey not found');
	}
	const peerCryptPkey = decode(peerCard.crypt_pkey, 'peerCard.crypt_pkey');
	const wrapped = (await DialogCrypto.wrapSenderMsgKey(senderMsgKey, peerCryptPkey)) as unknown as {
		peerKemWrapKeyB64: string;
		peerWrappedMsgKeyB64: string;
	};
	const { peerKemWrapKeyB64, peerWrappedMsgKeyB64 } = wrapped;

	const keysRow = {
		dialog_hash: dialogHash,
		sender_hash: myHash,
		peer_hash: peerHash,
		peer_kem_wrap_key_b64: peerKemWrapKeyB64,
		peer_wrapped_msg_key_b64: peerWrappedMsgKeyB64,
		owner_timestamp: nextOwnerTimestamp(),
		deleted_flag: false,
		sign_b64: null,
	};
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:beforeKeyPublish');
	const readyRow: ReadyRowIntent = { kind: 'ready-row', relation: 'dialog_keys', row: keysRow, mutationType: 'insert' };
	const intentId = await enqueueIntent(readyRow, myHash, 'dialog_keys');
	if (intentId === null) {
		throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
	}
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:beforeSigning');
	const signSkey = await signSkeyBytes();
	assertSessionUnchanged(token, 'ensureOwnDialogKeyPublished:afterSignSkeyExport');
	const handle = await signAndDispatchIntent(intentId, readyRow, signSkey, { token });
	const outcome = handle.phase === 'accepted' ? { kind: 'accepted' as const } : await handle.acceptance;
	if (outcome.kind !== 'accepted') {
		const reason = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
		throw new Error(`Dialog key creation was not accepted: ${reason}`);
	}
}

type Row = Record<string, unknown>;

async function ownPendingRowOf(relation: string, entityKey: string, owner: string): Promise<Row | null> {
	const [{ pendingEntries }, { entityKeyOf }, { freshestOf }] = await Promise.all([
		import('./outbox'), import('./writeContracts'), import('./acceptedSnapshot'),
	]);
	let best: Row | null = null;
	for (const entry of await pendingEntries(owner)) {
		if (entry.relation !== relation) continue;
		const m = entry.mutations?.[0] as { modified?: Row; changes?: Row } | undefined;
		const row = m?.modified ?? m?.changes;
		if (row && entityKeyOf(relation, row) === entityKey) best = freshestOf(best, row);
	}
	return best;
}

export async function trustedRowBase(
	relation: 'dialog_messages' | 'dialog_message_reactions',
	entityKey: string,
	owner: string,
	dialogHash: string,
): Promise<Row | null> {
	const { getAccepted, freshestOf } = await import('./acceptedSnapshot');
	const colls = getDialogCollections(dialogHash);
	const coll = (relation === 'dialog_messages' ? colls.messages : colls.reactions) as unknown as { preload?: () => Promise<void>; get(k: string): unknown };
	await coll.preload?.().catch(() => {});
	const shapeRow = (coll.get(entityKey) ?? null) as Row | null;
	const verified = shapeRow && (await verifyReplicatedRow(relation, shapeRow, getVerifiedSignPkey)).status === 'verified' ? shapeRow : null;
	const own = freshestOf(await getAccepted(relation, entityKey, owner), await ownPendingRowOf(relation, entityKey, owner));
	return freshestOf(verified, own);
}

export async function materializeMessageIntent(
	payload: DialogIntentPayload,
	token: SessionToken
): Promise<ReadyRowIntent | null> {
	if (token.userHash !== payload.ownerHash) {
		throw new SessionFencedError(
			`materializeMessageIntent: token account (${token.userHash}) does not match payload.ownerHash (${payload.ownerHash})`
		);
	}
	assertSessionUnchanged(token, 'materializeMessageIntent:start');
	switch (payload.kind) {
		case 'message':
		case 'checkpoint':
			return materializeNewMessage(payload, token);
		case 'edit':
		case 'delete': {
			const myKey = await ownSenderMsgKey(payload.peerHash);
			assertSessionUnchanged(token, 'materializeMessageIntent:afterKeyDerive');
			const base = await trustedRowBase('dialog_messages', payload.messageId, payload.ownerHash, payload.dialogHash);
			if (!base || base.sender_hash !== payload.ownerHash) {
				throw new Error(`materializeMessageIntent: no own revision of ${payload.messageId} to build on yet — the ${payload.kind} waits for recovery`);
			}
			const contentB64 = payload.kind === 'edit'
				? await DialogCrypto.encryptContent(myKey, encodeContent(payload.parts ?? []))
				: null;
			const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(payload.observedTails));
			assertSessionUnchanged(token, 'materializeMessageIntent:afterEncrypt');
			return {
				kind: 'ready-row',
				relation: 'dialog_messages',
				mutationType: 'update',
				row: {
					message_id: payload.messageId,
					dialog_hash: payload.dialogHash,
					sender_hash: payload.ownerHash,
					content_b64: contentB64,
					deleted_flag: payload.kind === 'delete',
					refs_map_b64: refsMapB64,
					parent_sign_hash: base.sign_hash,
					owner_timestamp: nextOwnerTimestamp(Number(base.owner_timestamp)),
				},
			};
		}
		case 'reaction': {
			await ensureOwnDialogKeyPublished(payload.peerHash, payload.dialogHash, payload.ownerHash, token);
			const myKey = await ownSenderMsgKey(payload.peerHash);
			assertSessionUnchanged(token, 'materializeMessageIntent:afterKeyDerive');
			const reactionHash = DialogCrypto.computeReactionHash(myKey, payload.messageId, payload.ownerHash, payload.emoji);
			const base = await trustedRowBase('dialog_message_reactions', reactionHash, payload.ownerHash, payload.dialogHash);
			const baseActive = !!base && !base.deleted_flag && base.message_sign_hash === payload.messageSignHash;
			if (baseActive === payload.desiredActive || (!base && !payload.desiredActive)) return null;
			const typeB64 = await DialogCrypto.encryptContent(myKey, payload.desiredActive ? payload.emoji : '');
			assertSessionUnchanged(token, 'materializeMessageIntent:afterEncrypt');
			return {
				kind: 'ready-row',
				relation: 'dialog_message_reactions',
				mutationType: base ? 'update' : 'insert',
				row: {
					reaction_hash: reactionHash,
					dialog_hash: payload.dialogHash,
					message_id: payload.messageId,
					message_sign_hash: payload.messageSignHash,
					reactor_hash: payload.ownerHash,
					type_b64: typeB64,
					deleted_flag: !payload.desiredActive,
					owner_timestamp: nextOwnerTimestamp(base ? Number(base.owner_timestamp) : null),
				},
			};
		}
		case 'receipt':
			await ensureOwnDialogKeyPublished(payload.peerHash, payload.dialogHash, payload.ownerHash, token);
			assertSessionUnchanged(token, 'materializeMessageIntent:afterKeyPublish');
			return { kind: 'ready-row', relation: 'dialog_message_receipts', mutationType: 'insert', row: payload.row };
	}
}

async function materializeNewMessage(
	payload: MessageIntentPayload,
	token: SessionToken
): Promise<ReadyRowIntent> {
	await ensureOwnDialogKeyPublished(payload.peerHash, payload.dialogHash, payload.ownerHash, token);
	assertSessionUnchanged(token, 'materializeMessageIntent:afterKeyPublish');
	const myKey = await ownSenderMsgKey(payload.peerHash);
	assertSessionUnchanged(token, 'materializeMessageIntent:afterKeyDerive');
	const contentB64 = await DialogCrypto.encryptContent(myKey, encodeContent(payload.parts));
	const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(payload.observedTails));
	assertSessionUnchanged(token, 'materializeMessageIntent:afterEncrypt');
	return {
		kind: 'ready-row',
		relation: 'dialog_messages',
		mutationType: 'insert',
		row: {
			message_id: payload.messageId,
			dialog_hash: payload.dialogHash,
			sender_hash: payload.ownerHash,
			content_b64: contentB64,
			deleted_flag: false,
			refs_map_b64: refsMapB64,
			parent_sign_hash: null,
			owner_timestamp: payload.ownerTimestamp,
		},
	};
}
