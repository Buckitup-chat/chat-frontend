import { getAccepted, freshestOf } from './acceptedSnapshot';
import { getServerState, tsOf, entityKeyFor } from './userStorageBase';
import { pendingEntries, quarantinedEntries, transitiveDependencyClosure } from './outbox';
import { assertSessionUnchanged } from './sessionGuard';
import { SessionFencedError, type SessionToken } from './outbox';
import { nextOwnerTimestamp } from './time';
import { IngestError } from './ingest';
import type { ReadyRowIntent } from './intentRecovery';
import type { DeliveryHandle } from './ingest';
import type { UserStorageRow } from './types';

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
	const { retiredVaults: _retired, ...stored } = record;
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

export function isReconcilableStorageConflict(e: unknown): boolean {
	return e instanceof IngestError && e.permanent && e.uniqueConflictOnly;
}

export const MAX_CONFLICT_RECONCILE_ATTEMPTS = 3;

export const RECONCILE_RETRY_DELAY_MS = 300;

export class BaseUnavailableError extends Error {}

const inProcessSlotLocks = new Map<string, Promise<unknown>>();

async function withCrossTabLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks?.request) return fn();
	return locks.request(`buckitup-storage-slot:${key}`, () => fn());
}

export function withStorageSlotLock<T>(userHash: string, uuid: string, fn: () => Promise<T>): Promise<T> {
	const key = `${userHash}|${uuid}`;
	const previous = inProcessSlotLocks.get(key) ?? Promise.resolve();
	const run = previous.then(() => withCrossTabLock(key, fn), () => withCrossTabLock(key, fn));
	const settled = run.then(
		() => undefined,
		() => undefined
	);
	inProcessSlotLocks.set(key, settled);
	settled.then(() => {
		if (inProcessSlotLocks.get(key) === settled) inProcessSlotLocks.delete(key);
	});
	return run;
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

async function pendingChainRow(userHash: string, uuid: string, excludeIds: string[] = []): Promise<UserStorageRow | null> {
	const entries = await pendingEntries(userHash);
	const exclude = excludeIds.length
		? transitiveDependencyClosure([...entries, ...(await quarantinedEntries(userHash))], excludeIds)
		: null;
	let best: UserStorageRow | null = null;
	for (const entry of entries) {
		if (entry.relation !== 'user_storage') continue;
		if (exclude?.has(entry.id)) continue;
		const row = rowOfMutation(entry.mutations[0]) as UserStorageRow | null;
		if (!row || row.user_hash !== userHash || row.uuid !== uuid) continue;
		best = freshestOf(best, row);
	}
	return best;
}

async function materializeJsonPatchValue(patch: Record<string, unknown>, baseRow: UserStorageRow | null): Promise<string> {
	if (!jsonCodec) {
		throw new Error('materializeStorageIntent: a jsonPatch intent requires setStorageJsonCodec to have been called (vault locked or codec never registered)');
	}
	const base = baseRow?.value_b64 ? await jsonCodec.decrypt(baseRow.value_b64) : null;
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

	const entityKey = entityKeyFor(payload.userHash, payload.uuid);
	const [acceptedRaw, server, pending] = await Promise.all([
		getAccepted('user_storage', entityKey, payload.userHash),
		getServerState(payload.userHash, payload.uuid),
		pendingChainRow(payload.userHash, payload.uuid, excludeIds),
	]);
	assertSessionUnchanged(token, 'materializeStorageIntent:afterBaseLookup');

	const accepted = acceptedRaw as UserStorageRow | null;
	if (server.state === 'unavailable' && !accepted && !pending) {
		throw new BaseUnavailableError(
			`user_storage base for ${entityKey} is unavailable and no accepted or in-flight local base exists`
		);
	}

	const serverRow = server.state === 'found' ? server.row : null;
	const baseRow = freshestOf(freshestOf(serverRow, accepted), pending);
	const mutationType = baseRow ? 'update' : 'insert';
	const parentSignHash = baseRow?.sign_hash ?? null;
	const ownerTimestamp = nextOwnerTimestamp(tsOf(baseRow));

	const valueB64 = payload.jsonPatch
		? await materializeJsonPatchValue(payload.jsonPatch, baseRow)
		: payload.valueB64;
	assertSessionUnchanged(token, 'materializeStorageIntent:afterJsonPatchMerge');

	return {
		kind: 'ready-row',
		relation: 'user_storage',
		mutationType,
		row: {
			user_hash: payload.userHash,
			uuid: payload.uuid,
			value_b64: valueB64,
			deleted_flag: payload.deletedFlag,
			owner_timestamp: ownerTimestamp,
			parent_sign_hash: parentSignHash,
		},
	};
}
