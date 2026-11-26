import {
	createContactAccess,
	type ContactAccessResult,
	type ContactAccessSession,
	type QueuedVouch,
	type RefusedVouch,
	type StoredContactAccessIntent,
	type ContactAccessDelivery,
	type ContactAccessWrite,
} from '@buckitup/pq-client/contactAccess';
import { getVerifiedSignPkey } from './cardRegistry';
import { readDeviceIdentity } from './deviceOwner';
import { IngestError, sendMutationsAndAwaitShape } from './ingest';
import { enqueueIntent, getIntent, intentsOf, resolveIntent, updateIntent } from './intents';
import { resolveSigningKey, type SigningKeySource } from './keyCustody';
import { discardEntry, pendingEntries, quarantinedEntries, withAccountLock, type OutboxEntry } from './outbox';
import { verifyReplicatedRow } from './rowVerification';
import { readShapeOnce } from './shapeRead';

export interface ContactVouchSession {
	issuerHash: string;
	signingKey: SigningKeySource;
	stillCurrent: () => boolean;
}

type AppSession = ContactAccessSession & { source: SigningKeySource };

const toSdkSession = (session: ContactVouchSession): AppSession => ({
	issuerHash: session.issuerHash,
	stillCurrent: session.stillCurrent,
	signingKey: () => resolveSigningKey(session.signingKey),
	source: session.signingKey,
});

const mutationOf = (write: ContactAccessWrite) => write.type === 'insert'
	? { type: 'insert', syncMetadata: { relation: 'vouch_tokens' }, modified: write.row }
	: { type: 'update', syncMetadata: { relation: 'vouch_tokens' }, original: write.key, changes: write.changes };

type VouchMutation = { modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown> };

const queuedVouchOf = (entry: OutboxEntry): QueuedVouch | null => {
	if (entry.relation !== 'vouch_tokens') return null;
	const m = entry.mutations[0] as VouchMutation | undefined;
	const key = m?.modified ?? m?.original;
	if (!key) return null;
	return {
		outboxId: entry.id,
		kind: String(key.kind),
		issuerHash: String(key.issuer_hash),
		subjectHash: String(key.subject_hash),
		ownerTimestamp: Number((m?.modified ?? m?.changes)?.owner_timestamp ?? 0),
		settled: entry.status === 'server_accepted_pending_reconcile',
	};
};

const send = async (write: ContactAccessWrite, session: ContactAccessSession): Promise<ContactAccessDelivery> => {
	let outboxId: string | null = null;
	try {
		const handle = await sendMutationsAndAwaitShape([mutationOf(write)], (session as AppSession).source, {
			onDurable: (id) => { outboxId = id; },
		});
		return { kind: handle.phase === 'accepted' ? 'accepted' : 'queued', outboxId: handle.outboxId ?? outboxId };
	} catch (error) {
		if (error instanceof IngestError && error.permanent) {
			return error.uniqueConflictOnly ? { kind: 'conflict', outboxId, error } : { kind: 'rejected', outboxId, error };
		}
		return { kind: 'failed', outboxId, error };
	}
};

export const contactAccess = createContactAccess({
	readDeviceIdentity: async () => {
		const device = await readDeviceIdentity();
		return device.kind === 'identity' ? device.identity : null;
	},
	readVouchRows: async ({ issuerHash, subjectHash }) => {
		const where = issuerHash ? `issuer_hash='${issuerHash}' AND subject_hash='${subjectHash}'` : `subject_hash='${subjectHash}'`;
		try {
			return { kind: 'rows', rows: await readShapeOnce<Record<string, unknown>>('vouch_tokens', where) };
		} catch (e) {
			if (/HTTP 40[13]\b/.test(String((e as Error)?.message))) return { kind: 'forbidden' };
			throw e;
		}
	},
	verifyVouchRow: async (row) => (await verifyReplicatedRow('vouch_tokens', row, getVerifiedSignPkey)).status === 'verified',
	intents: {
		list: async (issuerHash, { includeResolved }) => (await intentsOf(issuerHash, { includeResolved })).entries,
		get: (id) => getIntent(id),
		enqueue: (issuerHash, intent) => enqueueIntent(intent, issuerHash, 'vouch_tokens'),
		update: (id, intent) => updateIntent(id, intent),
		resolve: (id, outcome) => resolveIntent(id, { outcome }),
	},
	outbox: {
		send,
		queued: async (issuerHash) => (await pendingEntries(issuerHash)).map(queuedVouchOf).filter((q): q is QueuedVouch => !!q),
		refused: async (issuerHash): Promise<RefusedVouch[]> => (await quarantinedEntries(issuerHash))
			.filter((e) => e.relation === 'vouch_tokens')
			.map((e) => ({ outboxId: e.id, conflict: /already exists|conflict/i.test(e.lastError ?? '') })),
		discard: (outboxId) => discardEntry(outboxId),
	},
	lock: withAccountLock,
});

export function applyContactAccessIntent(entry: StoredContactAccessIntent, session: ContactVouchSession): Promise<ContactAccessResult> {
	return contactAccess.apply(entry, toSdkSession(session));
}

export function requestContactAccess(subjectHash: string, granted: boolean, session: ContactVouchSession, deviceId?: string): Promise<ContactAccessResult> {
	return contactAccess.request(toSdkSession(session), subjectHash, granted, deviceId);
}
