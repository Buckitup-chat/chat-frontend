import { readAcceptedBase, freshestOf } from './acceptedSnapshot';
import { getLiveServerState, tsOf, entityKeyFor, type ServerLookup } from './userStorageBase';
import { readableOwnEntries, transitiveDependencyClosure, SessionFencedError, type OutboxEntry, type SessionToken } from './outbox';
import { intentsOf, type IntentScanResult } from './intents';
import { AccountMismatchError, VaultLockedError } from './keyCustody';
import { assertNever, type StoredRead } from './storedRead';
import { assertSessionUnchanged } from './sessionGuard';
import { nextOwnerTimestamp } from './time';
import { IngestError } from './ingest';
import type { ReadyRowIntent } from './intentRecovery';
import type { DeliveryHandle } from './ingest';
import type { UserStorageRow } from './types';
import { verifyReplicatedRow, type RowVerification } from './rowVerification';
import { getVerifiedSignPkey } from './cardRegistry';

export interface StorageIntentPayload {
	kind: 'storage';
	relation: 'user_storage';
	userHash: string;
	uuid: string;
	deletedFlag: boolean;
	valueB64: string;
	jsonPatch?: Record<string, unknown>;
	revision: number;
	conflictAttempts?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A record that keeps entries by id — invitations, answers, a guardian's
// holdings — gains them from another device or tab between our read and our
// write. A patch names such maps in `$keyed` and edits them by key: an entry
// replaces the one under its key whole, null deletes it, and the keys the
// patch does not name stay as they are. The directive and the deletions
// survive coalescing with a pending patch and are stripped by the
// materializer (stripPatchDirectives).
//
// `$sticky` guards a keyed map against a writer that has not seen a final
// entry: `{ $sticky: { holdings: { state: ['dropped', 'given_back'] } } }`
// says an entry whose stored `state` is one of those values is replaced only
// by another such entry — never by a live one, nor deleted. A guardian's
// tombstone thus survives a stale device writing the share back, and an
// answer's decline survives a stale acceptance.
export const KEYED = '$keyed';
export const STICKY = '$sticky';
type StickyRules = Record<string, Record<string, unknown[]>>;
const keyedMapsOf = (record: Record<string, unknown> | null | undefined): string[] =>
	Array.isArray(record?.[KEYED]) ? (record[KEYED] as unknown[]).filter((k): k is string => typeof k === 'string') : [];
const stickyOf = (record: Record<string, unknown> | null | undefined): StickyRules => (isRecord(record?.[STICKY]) ? (record[STICKY] as StickyRules) : {});
/** Whether `entry` is final under `rule` ({ field: values }). */
const isSticky = (rule: Record<string, unknown[]> | undefined, entry: unknown): boolean =>
	!!rule && isRecord(entry) && Object.entries(rule).some(([field, values]) => Array.isArray(values) && values.includes(entry[field]));

function mergeKeyedMap(base: unknown, patch: Record<string, unknown>, rule: Record<string, unknown[]> | undefined): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(isRecord(base) ? base : {}) };
	for (const [id, entry] of Object.entries(patch)) {
		if (isSticky(rule, merged[id]) && !isSticky(rule, entry)) continue;
		merged[id] = entry;
	}
	return merged;
}

export function mergeJsonPatch(
	base: Record<string, unknown> | null,
	patch: Record<string, unknown>
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(base ?? {}), ...patch };
	const baseSlots = (base?.slots ?? {}) as Record<string, unknown>;
	const patchSlots = (patch.slots ?? {}) as Record<string, unknown>;
	if (base?.slots || patch.slots) merged.slots = { ...baseSlots, ...patchSlots };
	if (base?.staleVaults || base?.retiredVaults || 'vaultUuid' in patch || patch.retiredVaults) {
		mergeVaultList(merged, base, patch);
	}
	if (base?.contacts || patch.contacts) merged.contacts = mergeContacts(base?.contacts, patch.contacts);
	const keyed = keyedMapsOf(patch);
	const sticky = { ...stickyOf(base), ...stickyOf(patch) };
	for (const key of keyed) {
		if (isRecord(patch[key])) merged[key] = mergeKeyedMap(base?.[key], patch[key], sticky[key]);
	}
	const directive = [...new Set([...keyedMapsOf(base), ...keyed])];
	if (directive.length) merged[KEYED] = directive;
	if (Object.keys(sticky).length) merged[STICKY] = sticky;
	return merged;
}

type ContactEdits = Record<string, Record<string, unknown> | null>;

// The contacts slot holds { contacts: { [user_hash]: contact } }. A patch edits
// contacts by user_hash: its fields merge into the stored contact, and null
// deletes it. A contact deleted and added again in patches not sent yet must
// not inherit the deleted one's fields — `confirmed` above all, which only the
// QR handshake sets — so that addition is marked to replace, not merge.
// `base` is the stored record or an earlier pending patch, as for the vault
// list; the materializer strips the deletions and the marker.
const REPLACES = '$replaces';

function mergeContacts(base: unknown, patch: unknown): ContactEdits {
	const merged: ContactEdits = { ...((base ?? {}) as ContactEdits) };
	for (const [hash, edit] of Object.entries((patch ?? {}) as ContactEdits)) {
		const prev = merged[hash];
		if (edit === null) merged[hash] = null;
		else if (prev === null || edit[REPLACES]) merged[hash] = { ...edit, [REPLACES]: true };
		else merged[hash] = { ...(prev ?? {}), ...edit };
	}
	return merged;
}

const uuidList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// The recovery-vault list lives in the root record, which another device may
// patch between our read and the moment this patch lands on its base. So the
// list is never written as a value computed from a read: a replaced vaultUuid
// joins staleVaults here, against the actual base, and a patch removes entries
// only by naming them in retiredVaults. A vault dropped from the list would
// stay live and keep an old set of shares able to open the account.
//
// `base` is either the stored record or an earlier pending patch being
// coalesced with this one, so retiredVaults survives the merge; the
// materializer strips it (stripPatchDirectives) before encrypting.
function mergeVaultList(merged: Record<string, unknown>, base: Record<string, unknown> | null, patch: Record<string, unknown>): void {
	const stale = new Set([...uuidList(base?.staleVaults), ...uuidList(patch.staleVaults)]);
	const replaced = base?.vaultUuid;
	if ('vaultUuid' in patch && typeof replaced === 'string' && replaced !== patch.vaultUuid) stale.add(replaced);
	const retired = new Set([...uuidList(base?.retiredVaults), ...uuidList(patch.retiredVaults)]);
	for (const uuid of retired) stale.delete(uuid);
	if (typeof merged.vaultUuid === 'string') stale.delete(merged.vaultUuid);
	merged.staleVaults = [...stale];
	if (retired.size) merged.retiredVaults = [...retired];
	else delete merged.retiredVaults;
}

/** Keys of a patch that steer the merge and are not part of the stored record. */
export function stripPatchDirectives(record: Record<string, unknown>): Record<string, unknown> {
	const stored = { ...record };
	delete stored.retiredVaults;
	delete stored[KEYED];
	delete stored[STICKY];
	for (const key of keyedMapsOf(record)) {
		if (isRecord(stored[key])) stored[key] = Object.fromEntries(Object.entries(stored[key]).filter(([, v]) => v !== null));
	}
	if (stored.contacts) {
		stored.contacts = Object.fromEntries(
			Object.entries(stored.contacts as ContactEdits)
				.filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null)
				.map(([hash, { [REPLACES]: _marker, ...contact }]) => [hash, contact])
		);
	}
	return stored;
}

export interface StorageJsonCodec {
	decrypt(valueB64: string): Promise<Record<string, unknown>>;
	encrypt(value: Record<string, unknown>): Promise<{ valueB64: string; hashB64: string | null }>;
}
let jsonCodec: StorageJsonCodec | null = null;
export function setStorageJsonCodec(codec: StorageJsonCodec | null): void {
	jsonCodec = codec;
}
export function _getStorageJsonCodecForTests(): StorageJsonCodec | null {
	return jsonCodec;
}

/**
 * What a JSON-patch edit makes of the value this device shows, for showing
 * the edit before it is signed or delivered: the materializer's own merge.
 * Undefined when there is no codec or the value cannot be read; the local
 * copy then keeps the value it had.
 */
export async function projectJsonPatchValue(
	previousValueB64: string | null | undefined,
	patch: Record<string, unknown>
): Promise<string | undefined> {
	if (!jsonCodec) return undefined;
	try {
		const base = previousValueB64 ? await jsonCodec.decrypt(previousValueB64) : null;
		return (await jsonCodec.encrypt(stripPatchDirectives(mergeJsonPatch(base, patch)))).valueB64;
	} catch {
		return undefined;
	}
}

export function isReconcilableStorageConflict(e: unknown): boolean {
	return e instanceof IngestError && e.permanent && e.uniqueConflictOnly;
}

export const MAX_CONFLICT_RECONCILE_ATTEMPTS = 3;

export const RECONCILE_RETRY_DELAY_MS = 300;

export class BaseUnavailableError extends Error {}

const inProcessLocks = new Map<string, Promise<unknown>>();

async function withCrossTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks?.request) return fn();
	return locks.request(name, () => fn());
}

/**
 * Runs `fn` alone under `name`: queued behind earlier calls in this tab,
 * and under the Web Lock of that name across tabs where there is one.
 */
export function withNamedLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const previous = inProcessLocks.get(name) ?? Promise.resolve();
	const run = previous.then(() => withCrossTabLock(name, fn), () => withCrossTabLock(name, fn));
	const settled = run.then(
		() => undefined,
		() => undefined
	);
	inProcessLocks.set(name, settled);
	settled.then(() => {
		if (inProcessLocks.get(name) === settled) inProcessLocks.delete(name);
	});
	return run;
}

export function withStorageSlotLock<T>(userHash: string, uuid: string, fn: () => Promise<T>): Promise<T> {
	return withNamedLock(`buckitup-storage-slot:${userHash}|${uuid}`, fn);
}

export function signAndDispatchDurably(
	dispatch: (onDurable: () => void) => Promise<DeliveryHandle>
): { durable: Promise<void>; dispatchPromise: Promise<DeliveryHandle> } {
	let releaseDurable!: () => void;
	const durable = new Promise<void>((resolve) => { releaseDurable = resolve; });
	const dispatchPromise = dispatch(releaseDurable);
	dispatchPromise.then(releaseDurable, releaseDurable);
	return { durable, dispatchPromise };
}

const rowOfMutation = (m: unknown): Record<string, unknown> | null => {
	const shaped = m as { modified?: Record<string, unknown>; changes?: Record<string, unknown> } | undefined;
	return shaped?.modified ?? shaped?.changes ?? null;
};

export type StorageBaseBlockReason =
	| 'accepted_locked'
	| 'accepted_corrupt'
	| 'accepted_unavailable'
	/** An own outbox or intent record that could be a write to this slot cannot be read. */
	| 'pending_unreadable'
	/** An own write to this slot is built but not signed yet: it has no sign_hash to build on. */
	| 'pending_unsigned'
	/** No base is proven, and the shape is not live, so absence is not proven either. */
	| 'replicated_unavailable'
	/** The slot's replicated row does not verify, and nothing trusted here is newer: it may be the slot's state. */
	| 'replicated_unverified'
	/** The slot's replicated row cannot be verified yet (its author's card is not here), and nothing trusted here is newer. */
	| 'replicated_unverifiable';

export type StorageBaseDecision =
	| { kind: 'update'; base: UserStorageRow }
	| { kind: 'insert' }
	| { kind: 'blocked'; reason: StorageBaseBlockReason };

type PendingBase =
	| { kind: 'read'; row: UserStorageRow | null }
	| { kind: 'blocked'; reason: 'pending_unreadable' | 'pending_unsigned' };

const isOpenEntry = (entry: OutboxEntry): boolean =>
	entry.status !== 'quarantined' && entry.status !== 'discarded' && entry.status !== 'accepted';

async function pendingStorageBase(userHash: string, uuid: string, excludeIds: string[]): Promise<PendingBase> {
	const unreadable = { kind: 'blocked', reason: 'pending_unreadable' } as const;
	let outbox: OutboxEntry[];
	let intents: IntentScanResult;
	try {
		[outbox, intents] = await Promise.all([readableOwnEntries(userHash), intentsOf(userHash)]);
	} catch (e) {
		if (e instanceof SessionFencedError || e instanceof AccountMismatchError) throw e;
		return unreadable;
	}
	if (intents.issues.some((issue) => issue.owner === 'current')) return unreadable;

	const exclude = excludeIds.length ? transitiveDependencyClosure(outbox, excludeIds) : null;
	const slotRows: unknown[] = [];
	for (const entry of outbox) {
		if (entry.relation === 'user_storage' && isOpenEntry(entry) && !exclude?.has(entry.id)) slotRows.push(rowOfMutation(entry.mutations[0]));
	}
	for (const { intent } of intents.entries) {
		const built = intent as { kind?: unknown; relation?: unknown; row?: UserStorageRow; signedMutation?: unknown; outboxId?: string };
		if (built.kind === 'storage' || built.relation !== 'user_storage') continue;
		if (built.row?.user_hash !== userHash || built.row.uuid !== uuid) continue;
		if (built.outboxId && exclude?.has(built.outboxId)) continue;
		if (!built.signedMutation) return { kind: 'blocked', reason: 'pending_unsigned' };
		slotRows.push(rowOfMutation(built.signedMutation));
	}

	let best: UserStorageRow | null = null;
	for (const candidate of slotRows) {
		const row = candidate as UserStorageRow | null;
		if (!row || row.user_hash !== userHash || row.uuid !== uuid) continue;
		if (typeof row.sign_hash !== 'string' || !row.sign_hash) return unreadable;
		best = freshestOf(best, row);
	}
	return { kind: 'read', row: best };
}

function decideStorageBase(
	accepted: StoredRead<UserStorageRow>,
	pending: PendingBase,
	replicated: ServerLookup,
	replicatedVerification: RowVerification | null
): StorageBaseDecision {
	switch (accepted.kind) {
		case 'locked': return { kind: 'blocked', reason: 'accepted_locked' };
		case 'corrupt': return { kind: 'blocked', reason: 'accepted_corrupt' };
		case 'unavailable': return { kind: 'blocked', reason: 'accepted_unavailable' };
		case 'present':
		case 'missing': break;
		default: return assertNever(accepted);
	}
	if (pending.kind === 'blocked') return pending;

	const trusted = freshestOf(accepted.kind === 'present' ? accepted.row : null, pending.row);
	let replicatedBase: UserStorageRow | null = null;
	if (replicated.state === 'found') {
		if (replicatedVerification?.status === 'verified') replicatedBase = replicated.row;
		else if (!trusted || Number(replicated.row.owner_timestamp) >= Number(trusted.owner_timestamp)) {
			return { kind: 'blocked', reason: replicatedVerification?.status === 'unavailable' ? 'replicated_unverifiable' : 'replicated_unverified' };
		}
	}
	const base = freshestOf(replicatedBase, trusted);
	if (base) return { kind: 'update', base };
	if (accepted.kind === 'missing' && pending.row === null && replicated.state === 'absent') return { kind: 'insert' };
	return { kind: 'blocked', reason: 'replicated_unavailable' };
}

export async function resolveStorageBase(
	userHash: string,
	uuid: string,
	token: SessionToken,
	excludeIds: string[] = []
): Promise<StorageBaseDecision> {
	const [accepted, replicated, pending] = await Promise.all([
		readAcceptedBase('user_storage', entityKeyFor(userHash, uuid), userHash),
		getLiveServerState(userHash, uuid),
		pendingStorageBase(userHash, uuid, excludeIds),
	]);
	const replicatedVerification = replicated.state === 'found'
		? await verifyReplicatedRow('user_storage', replicated.row as unknown as Record<string, unknown>, getVerifiedSignPkey)
		: null;
	assertSessionUnchanged(token, 'resolveStorageBase:afterBaseLookup');
	return decideStorageBase(accepted, pending, replicated, replicatedVerification);
}

async function materializeJsonPatchValue(patch: Record<string, unknown>, decision: StorageBaseDecision & { kind: 'update' | 'insert' }): Promise<string> {
	if (!jsonCodec) {
		throw new Error('materializeStorageIntent: a jsonPatch intent requires setStorageJsonCodec to have been called (vault locked or codec never registered)');
	}
	const baseValue = decision.kind === 'update' ? decision.base.value_b64 : '';
	const base = baseValue ? await jsonCodec.decrypt(baseValue) : null;
	const merged = stripPatchDirectives(mergeJsonPatch(base, patch));
	const { valueB64 } = await jsonCodec.encrypt(merged);
	return valueB64;
}

export async function materializeStorageIntent(
	payload: StorageIntentPayload,
	token: SessionToken,
	excludeIds: string[] = []
): Promise<ReadyRowIntent> {
	if (token.userHash !== payload.userHash) {
		throw new SessionFencedError(
			`materializeStorageIntent: token account (${token.userHash}) does not match payload.userHash (${payload.userHash})`
		);
	}
	assertSessionUnchanged(token, 'materializeStorageIntent:start');

	const decision = await resolveStorageBase(payload.userHash, payload.uuid, token, excludeIds);
	if (decision.kind === 'blocked' && decision.reason === 'accepted_locked') {
		throw new VaultLockedError(`user_storage base for ${entityKeyFor(payload.userHash, payload.uuid)} cannot be read while the account is locked`);
	}
	if (decision.kind === 'blocked') {
		throw new BaseUnavailableError(
			`user_storage base for ${entityKeyFor(payload.userHash, payload.uuid)} is not proven (${decision.reason}); the intent waits for recovery`
		);
	}
	const base = decision.kind === 'update' ? decision.base : null;

	const valueB64 = payload.jsonPatch
		? await materializeJsonPatchValue(payload.jsonPatch, decision)
		: payload.valueB64;
	assertSessionUnchanged(token, 'materializeStorageIntent:afterJsonPatchMerge');

	return {
		kind: 'ready-row',
		relation: 'user_storage',
		mutationType: decision.kind,
		row: {
			user_hash: payload.userHash,
			uuid: payload.uuid,
			value_b64: valueB64,
			deleted_flag: payload.deletedFlag,
			owner_timestamp: nextOwnerTimestamp(tsOf(base)),
			parent_sign_hash: base?.sign_hash ?? null,
		},
	};
}
