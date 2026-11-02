import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { signFields, type SignableFields } from '@buckitup/pq-client/signature';
import { signableFields, wireBool } from '@buckitup/pq-client/schema';
import { getVerifiedSignPkey } from './cardRegistry';
import { claimDeviceIfUnowned } from './deviceOwner';
import { IngestError, sendMutationsAndAwaitShape } from './ingest';
import { enqueueIntent, intentsOf, resolveIntent, updateIntent, type IntentEntry } from './intents';
import { resolveSigningKey, type SigningKeySource } from './keyCustody';
import { SessionFencedError, discardEntry, pendingEntries, quarantinedEntries, withAccountLock, type OutboxEntry } from './outbox';
import { verifyReplicatedRow } from './rowVerification';
import { readShapeOnce } from './shapeRead';
import { nextOwnerTimestamp } from './time';

const USER_HASH = /^u_[0-9a-f]{128}$/;

export type VouchStep = 'inserted' | 'updated' | 'unchanged' | 'unverified';

export interface DispatchedVouch {
	kind: string;
	outboxId: string;
	timestamp: number;
	accepted: boolean;
}

export type ContactVouchOutcome =
	| { kind: 'done'; steps: Record<string, VouchStep>; dispatched: DispatchedVouch[] }
	| { kind: 'skipped'; reason: 'no-owner' | 'not-vouched' | 'identity-unavailable' | 'signed-out' };

export interface ContactVouchSession {
	issuerHash: string;
	signingKey: SigningKeySource;
	stillCurrent: () => boolean;
}

export interface ContactVouchRequest extends ContactVouchSession {
	subjectHash: string;
}

interface VouchRow {
	kind: string;
	issuer_hash: string;
	subject_hash: string;
	owner_timestamp: number;
	deleted_flag: boolean;
	sign_b64: string;
}
type VouchKey = Pick<VouchRow, 'kind' | 'issuer_hash' | 'subject_hash'>;

type Stored = { state: 'absent' } | { state: 'verified'; row: VouchRow } | { state: 'unverified' };

interface Superseded {
	floor: number;
	exists?: boolean;
}

const SCOPES = ['read', 'write'] as const;

const coversDeviceStorage = (kind: string, deviceId: string) => {
	const wanted = ['device', deviceId, 'storage'];
	return kind.split('.').every((seg, i) => i >= wanted.length || seg === '*' || seg === wanted[i]);
};

async function holdsDeviceVouch(userHash: string, deviceId: string): Promise<boolean> {
	let rows: Record<string, unknown>[];
	try {
		rows = await readShapeOnce<Record<string, unknown>>('vouch_tokens', `subject_hash='${userHash}'`);
	} catch (e) {
		if (/HTTP 40[13]\b/.test(String((e as Error)?.message))) return false;
		throw e;
	}
	for (const row of rows) {
		if (row.subject_hash !== userHash || typeof row.kind !== 'string' || wireBool(row.deleted_flag)) continue;
		if (!coversDeviceStorage(row.kind, deviceId)) continue;
		if ((await verifyReplicatedRow('vouch_tokens', row, getVerifiedSignPkey)).status === 'verified') return true;
	}
	return false;
}

async function readStored(issuerHash: string, subjectHash: string): Promise<Map<string, Stored>> {
	const rows = await readShapeOnce<Record<string, unknown>>(
		'vouch_tokens',
		`issuer_hash='${issuerHash}' AND subject_hash='${subjectHash}'`,
	);
	const stored = new Map<string, Stored>();
	for (const row of rows) {
		if (row.issuer_hash !== issuerHash || row.subject_hash !== subjectHash || typeof row.kind !== 'string') continue;
		const verdict = await verifyReplicatedRow('vouch_tokens', row, getVerifiedSignPkey);
		stored.set(row.kind, verdict.status === 'verified'
			? {
				state: 'verified',
				row: {
					kind: row.kind,
					issuer_hash: issuerHash,
					subject_hash: subjectHash,
					owner_timestamp: Number(row.owner_timestamp),
					deleted_flag: wireBool(row.deleted_flag),
					sign_b64: String(row.sign_b64),
				},
			}
			: { state: 'unverified' });
	}
	return stored;
}

type VouchMutation = { modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown> };

const entryRow = (entry: OutboxEntry): { kind: string; issuer: string; subject: string; timestamp: number } | null => {
	if (entry.relation !== 'vouch_tokens') return null;
	const m = entry.mutations[0] as VouchMutation | undefined;
	const key = m?.modified ?? m?.original;
	if (!key) return null;
	return {
		kind: String(key.kind),
		issuer: String(key.issuer_hash),
		subject: String(key.subject_hash),
		timestamp: Number((m?.modified ?? m?.changes)?.owner_timestamp ?? 0),
	};
};

const raise = (map: Map<string, Superseded>, kind: string, timestamp: number, exists = false) => {
	const was = map.get(kind);
	map.set(kind, { floor: Math.max(was?.floor ?? 0, timestamp), exists: (was?.exists ?? false) || exists });
};

async function supersedeQueued(issuerHash: string, keys: VouchKey[], into: Map<string, Superseded>, keep: Set<string>): Promise<void> {
	const kinds = new Set(keys.map((k) => k.kind));
	for (const entry of await pendingEntries(issuerHash)) {
		const row = entryRow(entry);
		if (!row || row.subject !== keys[0].subject_hash || row.issuer !== issuerHash || !kinds.has(row.kind)) continue;
		raise(into, row.kind, row.timestamp);
		if (!keep.has(row.kind)) await discardEntry(entry.id);
	}
}

const signedRow = (fields: Omit<VouchRow, 'sign_b64'>, signSkey: Uint8Array): VouchRow => {
	const signable = signableFields('vouch_tokens', fields) as SignableFields;
	return { ...fields, sign_b64: signFields(signable, signSkey) };
};

type Plan =
	| { mutation: unknown; step: 'inserted' | 'updated' }
	| { mutation: null; step: 'unchanged' | 'unverified' };

const insert = (key: VouchKey, granted: boolean, after: number, signSkey: Uint8Array): Plan => ({
	mutation: {
		type: 'insert',
		syncMetadata: { relation: 'vouch_tokens' },
		modified: signedRow({ ...key, owner_timestamp: nextOwnerTimestamp(after), deleted_flag: !granted }, signSkey),
	},
	step: 'inserted',
});

const update = (key: VouchKey, granted: boolean, after: number, signSkey: Uint8Array): Plan => {
	const row = signedRow({ ...key, owner_timestamp: nextOwnerTimestamp(after), deleted_flag: !granted }, signSkey);
	return {
		mutation: {
			type: 'update',
			syncMetadata: { relation: 'vouch_tokens' },
			original: key,
			changes: { deleted_flag: row.deleted_flag, owner_timestamp: row.owner_timestamp, sign_b64: row.sign_b64 },
		},
		step: 'updated',
	};
};

const planFor = (key: VouchKey, stored: Stored, granted: boolean, superseded: Superseded | undefined, signSkey: Uint8Array): Plan => {
	if (stored.state === 'unverified') return { mutation: null, step: 'unverified' };
	const floor = superseded?.floor ?? 0;
	if (stored.state === 'absent') {
		if (superseded?.exists) return update(key, granted, floor, signSkey);
		if (!granted && !superseded) return { mutation: null, step: 'unchanged' };
		return insert(key, granted, floor, signSkey);
	}
	if (!superseded && stored.row.deleted_flag === !granted) return { mutation: null, step: 'unchanged' };
	return update(key, granted, Math.max(stored.row.owner_timestamp, floor), signSkey);
};

const isInsertConflict = (e: unknown) => e instanceof IngestError && e.uniqueConflictOnly;
const isFinal = (e: unknown) => e instanceof IngestError && e.permanent;

async function setContactVouches(request: ContactVouchRequest, granted: boolean, refused = new Map<string, Superseded>()): Promise<ContactVouchOutcome> {
	const { issuerHash, subjectHash, signingKey, stillCurrent } = request;
	const fenced = () => new SessionFencedError('contact vouches: the account changed before the rows were sent');

	// An ownerless device is claimed first: whoever acts here has signed in here (deviceOwner.ts).
	const { identity } = await claimDeviceIfUnowned(issuerHash, async (challenge) => ml_dsa87.sign(challenge, await resolveSigningKey(signingKey)));
	if (!stillCurrent()) throw fenced();
	if (!identity) return { kind: 'skipped', reason: 'identity-unavailable' };
	if (identity.adminHash === null) return { kind: 'skipped', reason: 'no-owner' };
	if (!USER_HASH.test(subjectHash)) throw new Error('contact vouches: the subject is not a user hash');
	if (granted && identity.adminHash !== issuerHash) {
		const vouched = await holdsDeviceVouch(issuerHash, identity.deviceId);
		if (!stillCurrent()) throw fenced();
		if (!vouched) return { kind: 'skipped', reason: 'not-vouched' };
	}

	const keys: VouchKey[] = SCOPES.map((scope) => ({
		kind: `device.${identity.deviceId}.storage.${scope}`,
		issuer_hash: issuerHash,
		subject_hash: subjectHash,
	}));
	const stored = await readStored(issuerHash, subjectHash);
	if (!stillCurrent()) throw fenced();
	const signSkey = await resolveSigningKey(signingKey);
	const superseded = new Map(refused);
	const unverified = new Set(keys.filter((k) => stored.get(k.kind)?.state === 'unverified').map((k) => k.kind));
	await supersedeQueued(issuerHash, keys, superseded, unverified);
	if (!stillCurrent()) throw fenced();

	const plans = keys.map((key) => planFor(key, stored.get(key.kind) ?? { state: 'absent' }, granted, superseded.get(key.kind), signSkey));
	const dispatched: DispatchedVouch[] = [];
	const timestampOf = (mutation: unknown) => Number(((mutation as VouchMutation).modified ?? (mutation as VouchMutation).changes)?.owner_timestamp ?? 0);
	const entryOf: (string | null)[] = keys.map(() => null);
	const send = async (mutation: unknown, kind: string, scope?: number) => {
		let outboxId: string | null = null;
		const handle = await sendMutationsAndAwaitShape([mutation], signingKey, {
			onDurable: (id) => {
				outboxId = id;
				if (scope !== undefined) entryOf[scope] = id;
			},
		}).catch((e) => {
			if (outboxId) dispatched.push({ kind, outboxId, timestamp: timestampOf(mutation), accepted: false });
			throw e;
		});
		if (outboxId) dispatched.push({ kind, outboxId, timestamp: timestampOf(mutation), accepted: handle.phase === 'accepted' });
		return handle;
	};

	if (!stillCurrent()) throw fenced();
	const sends = await Promise.allSettled(plans.map((plan, i) => (plan.mutation ? send(plan.mutation, keys[i].kind, i) : Promise.resolve(null))));

	const steps: Record<string, VouchStep> = {};
	let failure: unknown = null;
	for (const [i, key] of keys.entries()) {
		const plan = plans[i];
		const sent = sends[i];
		if (sent.status === 'fulfilled' || (entryOf[i] && !isFinal(sent.reason))) {
			steps[key.kind] = plan.step;
			continue;
		}
		if (plan.step !== 'inserted' || !isInsertConflict(sent.reason)) {
			failure ??= sent.reason;
			continue;
		}
		if (!stillCurrent()) throw fenced();
		const refusedId = entryOf[i];
		if (refusedId) {
			await discardEntry(refusedId);
			const at = dispatched.findIndex((d) => d.outboxId === refusedId);
			if (at >= 0) dispatched.splice(at, 1);
		}
		const again = (await readStored(issuerHash, subjectHash)).get(key.kind);
		const next = again && again.state !== 'absent'
			? planFor(key, again, granted, superseded.get(key.kind), signSkey)
			: update(key, granted, superseded.get(key.kind)?.floor ?? 0, signSkey);
		if (!next.mutation) {
			steps[key.kind] = next.step;
			continue;
		}
		if (!stillCurrent()) throw fenced();
		await send(next.mutation, key.kind);
		steps[key.kind] = next.step;
	}
	if (failure) throw failure;
	return { kind: 'done', steps, dispatched };
}

export const CONTACT_ACCESS_INTENT = 'contact-access';

export interface ContactAccessIntent {
	kind: typeof CONTACT_ACCESS_INTENT;
	subjectHash: string;
	granted: boolean;
	dispatched?: DispatchedVouch[];
	open?: boolean;
	learned?: { kind: string; floor: number; exists: boolean }[];
}

export type ContactAccessResult = 'resolved' | 'retry';

const isContactAccess = (intent: unknown, subjectHash?: string): intent is ContactAccessIntent =>
	(intent as ContactAccessIntent | null)?.kind === CONTACT_ACCESS_INTENT
	&& (subjectHash === undefined || (intent as ContactAccessIntent).subjectHash === subjectHash);

async function newestFor(issuerHash: string, subjectHash: string): Promise<IntentEntry<ContactAccessIntent>[]> {
	const { entries } = await intentsOf(issuerHash);
	return (entries.filter((e) => isContactAccess(e.intent, subjectHash)) as IntentEntry<ContactAccessIntent>[])
		.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export async function applyContactAccessIntent(entry: IntentEntry<ContactAccessIntent>, session: ContactVouchSession): Promise<ContactAccessResult> {
	const { subjectHash, granted } = entry.intent;
	return withAccountLock(`contact-access|${session.issuerHash}|${subjectHash}`, async () => {
		const queue = await newestFor(session.issuerHash, subjectHash);
		const newest = queue[queue.length - 1];
		if (!newest) return 'resolved';
		if (newest.id !== entry.id) {
			await resolveIntent(entry.id, { outcome: 'superseded' });
			return 'resolved';
		}
		const intent = newest.intent;

		const dispatched = intent.dispatched ?? [];
		const refused = new Map<string, Superseded>();
		for (const l of intent.learned ?? []) raise(refused, l.kind, l.floor, l.exists);
		if (dispatched.length > 0) {
			const pending = await pendingEntries(session.issuerHash);
			const unsettled = new Set(pending.filter((e) => e.status !== 'server_accepted_pending_reconcile').map((e) => e.id));
			if (dispatched.some((d) => unsettled.has(d.outboxId))) return 'retry';
			const quarantined = new Map((await quarantinedEntries(session.issuerHash)).map((e) => [e.id, e]));
			for (const d of dispatched) {
				const entry = quarantined.get(d.outboxId);
				if (!entry) continue;
				raise(refused, d.kind, d.timestamp, /already exists|conflict/i.test(entry.lastError ?? ''));
				await discardEntry(d.outboxId);
			}
			if (refused.size === 0 && !intent.open) {
				await resolveIntent(entry.id, { outcome: 'applied' });
				return 'resolved';
			}
		}

		let outcome: ContactVouchOutcome;
		try {
			outcome = await setContactVouches({ ...session, subjectHash }, granted, refused);
		} catch (e) {
			console.warn(`[contacts] device access for a contact was not ${granted ? 'granted' : 'revoked'} yet, will retry:`, e);
			if (refused.size > 0) {
				const learned = [...refused].map(([kind, r]) => ({ kind, floor: r.floor, exists: r.exists ?? false }));
				await updateIntent(entry.id, { ...intent, dispatched: [], open: true, learned });
			}
			return 'retry';
		}
		if (outcome.kind === 'skipped') {
			if (outcome.reason === 'identity-unavailable') return 'retry';
			await resolveIntent(entry.id, { outcome: `skipped:${outcome.reason}` });
			return 'resolved';
		}
		const open = Object.values(outcome.steps).includes('unverified');
		if (open) console.warn('[contacts] a vouch row of this contact does not verify; that scope waits for the next try');
		if (!open && outcome.dispatched.every((d) => d.accepted)) {
			await resolveIntent(entry.id, { outcome: 'applied' });
			return 'resolved';
		}
		await updateIntent(entry.id, { ...intent, dispatched: outcome.dispatched, open, learned: [] });
		return 'retry';
	});
}

export async function requestContactAccess(subjectHash: string, granted: boolean, session: ContactVouchSession): Promise<ContactAccessResult> {
	const intent: ContactAccessIntent = { kind: CONTACT_ACCESS_INTENT, subjectHash, granted };
	const id = await enqueueIntent(intent, session.issuerHash, 'vouch_tokens');
	if (!id) throw new Error('contact access: the request could not be stored on this device');
	return applyContactAccessIntent({ id, userHash: session.issuerHash, relation: 'vouch_tokens', intent, createdAt: Date.now() }, session);
}
