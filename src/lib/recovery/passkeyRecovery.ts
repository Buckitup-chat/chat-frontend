
import { sha256 } from '@noble/hashes/sha256';
import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { hkdfDerive } from '@buckitup/pq-client/hkdf';
import { deriveVaultLocator } from '@buckitup/pq-client/vaultEnvelope';
import { fromBase64 } from '@buckitup/pq-client/signature';
import { TransportError } from '@buckitup/pq-client/transport';
import {
	assertPrf, readLockSeed, lockSeedFromPrf, lockRecordFor, newLockSalt,
	PrfMissingError, PasskeyMismatchError,
	type Credentials, type PrfLockRecord, type PrfAssertion,
} from '@buckitup/pq-client/vaultLock';
import { assertBackupConsistent, BackupMismatchError, type BackupContents } from '@/lib/backupContents';
import { ShapeReadError } from '@/lib/data/shapeRead';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import { VaultLookupError } from './vault';

export const RECOVERY_PRF_LABEL = 'buckitup/vault-recovery/v1';
export const PRF_RECOVERY_SALT = 'buckitup/prf-recovery/v1';
const WRAP_INFO = 'wrap';
const FINGERPRINT_LABEL = 'buckitup/passkey-recovery/fingerprint/v1';

export const PASSKEY_RECOVERY_SLOT = 'recovery-passkeys';

export const recoverySalt = (): Uint8Array<ArrayBuffer> => new Uint8Array(sha256(new TextEncoder().encode(RECOVERY_PRF_LABEL)));

export const recoveryWrapKey = (prf: Uint8Array): Uint8Array => {
	if (prf.length !== 32) throw new PrfMissingError();
	return hkdfDerive(prf, PRF_RECOVERY_SALT, WRAP_INFO, 32);
};

export const credentialKey = (credentialId: string): string => bytesToHex(sha3_256(fromBase64(credentialId)));

export interface PasskeyEnvelopeEntry {
	label: string;
	locator: string;
	synced: boolean | null;
	eligible: boolean | null;
	created_at: number;
	fingerprint: string;
	state: 'pending' | 'active';
}

const DISPLAY_AND_DEVICE_FIELDS = ['name', 'avatar', 'avatarId', 'userStorage', 'vaultId', 'vaultLock'];

const sortedKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => [k, sortedKeys(v)]));
	}
	return value;
};

export const fingerprintOf = (backup: BackupContents): string => {
	const identity = Object.fromEntries(Object.entries(backup.identity).filter(([name]) => !DISPLAY_AND_DEVICE_FIELDS.includes(name)));
	const canonical = JSON.stringify(sortedKeys({ identity, keys: backup.keys }));
	return bytesToHex(sha3_256(new TextEncoder().encode(`${FINGERPRINT_LABEL}\n${canonical}`)));
};

export const isCopyStale = (entry: PasskeyEnvelopeEntry, exportedNow: string): boolean => entry.fingerprint !== exportedNow;

export type PrfSupport = 'supported' | 'unsupported' | 'unknown';

export const detectPrfSupport = async (): Promise<PrfSupport> => {
	if (typeof navigator === 'undefined' || typeof navigator.credentials?.get !== 'function') return 'unsupported';
	const capabilities = typeof PublicKeyCredential !== 'undefined'
		? (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities
		: undefined;
	if (typeof capabilities !== 'function') return 'unknown';
	try {
		const prf = (await capabilities.call(PublicKeyCredential))?.['extension:prf'];
		return prf === true ? 'supported' : prf === false ? 'unsupported' : 'unknown';
	} catch {
		return 'unknown';
	}
};

export type PasskeyRecoveryFailure =
	| 'cancelled'
	| 'no-prf'
	| 'wrong-passkey'
	| 'absent'
	| 'foreign'
	| 'unauthorized'
	| 'network'
	| 'server'
	| 'invalid'
	| 'account-changed'
	| 'passkey-failed';

export class PasskeyRecoveryError extends Error {
	constructor(readonly reason: PasskeyRecoveryFailure, options?: { cause?: unknown }) {
		super(`passkey recovery: ${reason}`, options);
		this.name = 'PasskeyRecoveryError';
	}
}

const isDomError = (e: unknown, name: string) => (e as { name?: string } | null)?.name === name;

export const recoveryFailureOf = (e: unknown): PasskeyRecoveryFailure | null => {
	if (e instanceof PasskeyRecoveryError) return e.reason;
	if (isDomError(e, 'NotAllowedError') || isDomError(e, 'AbortError')) return 'cancelled';
	if (e instanceof PrfMissingError) return 'no-prf';
	if (e instanceof PasskeyMismatchError) return 'wrong-passkey';
	if (e instanceof VaultLookupError) return e.reason;
	if (e instanceof ShapeReadError) return e.status === 401 ? 'unauthorized' : 'server';
	if (e instanceof TransportError) return e.network ? 'network' : 'server';
	if (isDomError(e, 'TimeoutError') || e instanceof TypeError) return 'network';
	if (e instanceof BackupMismatchError) return 'invalid';
	if (e instanceof SessionFencedError) return 'account-changed';
	return null;
};

const PRF_REFUSALS = ['NotSupportedError', 'TypeError'];
const refusesPrf = (e: unknown) => PRF_REFUSALS.includes((e as { name?: string } | null)?.name ?? '');

const passkeyFailureOf = (e: unknown): PasskeyRecoveryFailure => {
	if (e instanceof PasskeyRecoveryError) return e.reason;
	if (isDomError(e, 'NotAllowedError') || isDomError(e, 'AbortError')) return 'cancelled';
	if (e instanceof PrfMissingError || refusesPrf(e)) return 'no-prf';
	if (e instanceof PasskeyMismatchError) return 'wrong-passkey';
	return 'passkey-failed';
};

const askPasskey = async <T>(ask: () => Promise<T>): Promise<T> => {
	try {
		return await ask();
	} catch (e) {
		throw e instanceof PasskeyRecoveryError ? e : new PasskeyRecoveryError(passkeyFailureOf(e), { cause: e });
	}
};

const asRecoveryError = (e: unknown): unknown => {
	const reason = recoveryFailureOf(e);
	return reason && !(e instanceof PasskeyRecoveryError) ? new PasskeyRecoveryError(reason, { cause: e }) : e;
};

const wrapKeyFrom = (prf: Uint8Array): Uint8Array => {
	try {
		return recoveryWrapKey(prf);
	} finally {
		prf.fill(0);
	}
};

export type DeviceBoundReason = 'not-eligible' | 'unknown';

export interface EnableDeps {
	credentials: Credentials;
	owner: string;
	lock: PrfLockRecord;
	label: string;
	previous?: PasskeyEnvelopeEntry | null;
	assertCurrent: () => void;
	assertReadable: (wrapKey: Uint8Array) => Promise<void>;
	exportBackup: () => Promise<BackupContents>;
	publish: (wrapKey: Uint8Array, json: string) => Promise<string>;
	recordEntry: (key: string, entry: PasskeyEnvelopeEntry | null) => Promise<void>;
	confirmDeviceBound: (reason: DeviceBoundReason) => Promise<boolean>;
	now?: () => number;
}

export const enablePasskeyRecovery = async (deps: EnableDeps): Promise<{ key: string; entry: PasskeyEnvelopeEntry } | null> => {
	const { credentials, lock, assertCurrent } = deps;
	const ask = () => askPasskey(() => assertPrf(credentials, {
		rpId: lock.rpId, credentialId: lock.credentialId, transports: lock.transports, first: recoverySalt(),
	}));
	let answer: PrfAssertion;
	try {
		assertCurrent();
		answer = await ask();
		const decided = deps.previous != null && deps.previous.eligible !== true;
		if (answer.flags?.backupEligible !== true && !decided) {
			answer.first.fill(0);
			answer.second?.fill(0);
			if (!(await deps.confirmDeviceBound(answer.flags ? 'not-eligible' : 'unknown'))) return null;
			assertCurrent();
			answer = await ask();
		}
	} catch (e) {
		throw asRecoveryError(e);
	}
	answer.second?.fill(0);
	const wrapKey = wrapKeyFrom(answer.first);
	try {
		assertCurrent();
		await deps.assertReadable(wrapKey);
		assertCurrent();
		const backup = await deps.exportBackup();
		assertCurrent();
		assertBackupConsistent(backup);
		if (backup.identity.user_hash !== deps.owner) throw new SessionFencedError('passkey recovery: the backup is another account\'s');
		const key = credentialKey(lock.credentialId);
		const entry: PasskeyEnvelopeEntry = {
			label: deps.label,
			locator: deriveVaultLocator(wrapKey),
			synced: answer.flags?.backupState ?? null,
			eligible: answer.flags?.backupEligible ?? null,
			created_at: deps.previous?.created_at ?? Math.floor((deps.now?.() ?? Date.now()) / 1000),
			fingerprint: fingerprintOf(backup),
			state: 'pending',
		};
		await deps.recordEntry(key, entry);
		assertCurrent();
		await deps.publish(wrapKey, JSON.stringify(backup));
		assertCurrent();
		const active = { ...entry, state: 'active' as const };
		await deps.recordEntry(key, active);
		return { key, entry: active };
	} catch (e) {
		throw asRecoveryError(e);
	} finally {
		wrapKey.fill(0);
	}
};

export interface RenewDeps {
	prf: Uint8Array;
	flags: { backupEligible: boolean; backupState: boolean } | null;
	owner: string;
	lock: PrfLockRecord;
	assertCurrent: () => void;
	readEntry: (key: string) => Promise<PasskeyEnvelopeEntry | null>;
	assertReadable: EnableDeps['assertReadable'];
	exportBackup: EnableDeps['exportBackup'];
	publish: EnableDeps['publish'];
	recordEntry: EnableDeps['recordEntry'];
}

export type RenewOutcome = 'renewed' | 'current' | 'not-enabled' | 'unfinished';

export const renewPasskeyRecoveryAtLogin = async (deps: RenewDeps): Promise<RenewOutcome> => {
	let wrapKey: Uint8Array;
	try {
		wrapKey = wrapKeyFrom(deps.prf);
	} catch (e) {
		throw asRecoveryError(e);
	}
	try {
		deps.assertCurrent();
		const key = credentialKey(deps.lock.credentialId);
		const entry = await deps.readEntry(key);
		deps.assertCurrent();
		if (!entry) return 'not-enabled';
		if (entry.state !== 'active') return 'unfinished';
		if (entry.locator !== deriveVaultLocator(wrapKey)) throw new PasskeyRecoveryError('foreign');
		const backup = await deps.exportBackup();
		deps.assertCurrent();
		assertBackupConsistent(backup);
		if (backup.identity.user_hash !== deps.owner) throw new SessionFencedError('passkey recovery: the backup is another account\'s');
		const fingerprint = fingerprintOf(backup);
		if (entry.fingerprint === fingerprint) return 'current';
		await deps.assertReadable(wrapKey);
		deps.assertCurrent();
		await deps.publish(wrapKey, JSON.stringify(backup));
		deps.assertCurrent();
		await deps.recordEntry(key, {
			...entry,
			fingerprint,
			synced: deps.flags?.backupState ?? entry.synced,
			eligible: deps.flags?.backupEligible ?? entry.eligible,
		});
		return 'renewed';
	} catch (e) {
		throw asRecoveryError(e);
	} finally {
		wrapKey.fill(0);
	}
};

export interface RecoverDeps {
	credentials: Credentials;
	rpId: string;
	fetchVault: (wrapKey: Uint8Array) => Promise<BackupContents>;
}

export interface Recovered {
	backup: BackupContents;
	prepared: { lock: PrfLockRecord; seed: Uint8Array };
}

const assertForRecovery = async (credentials: Credentials, rpId: string, lockSalt: Uint8Array<ArrayBuffer>): Promise<PrfAssertion> => {
	let credentialId: string | null = null;
	try {
		return await assertPrf(credentials, { rpId, first: recoverySalt(), second: lockSalt });
	} catch (e) {
		if (e instanceof PrfMissingError && e.credentialId) credentialId = e.credentialId;
		else if (!refusesPrf(e)) throw e;
	}
	return assertPrf(credentials, { rpId, credentialId, first: recoverySalt() });
};

export const recoverWithPasskey = async ({ credentials, rpId, fetchVault }: RecoverDeps): Promise<Recovered> => {
	const salt = newLockSalt();
	let answer: PrfAssertion | null = null;
	let wrapKey: Uint8Array | null = null;
	let seed: Uint8Array | null = null;
	try {
		answer = await askPasskey(() => assertForRecovery(credentials, rpId, salt));
		const lock = lockRecordFor({ credentialId: answer.credentialId, rpId, salt });
		wrapKey = recoveryWrapKey(answer.first);
		answer.first.fill(0);
		if (answer.second) seed = lockSeedFromPrf(answer.second);
		answer.second?.fill(0);
		const backup = await fetchVault(wrapKey);
		wrapKey.fill(0);
		assertBackupConsistent(backup);
		seed ??= await askPasskey(() => readLockSeed(credentials, lock));
		return { backup, prepared: { lock, seed } };
	} catch (e) {
		seed?.fill(0);
		throw asRecoveryError(e);
	} finally {
		answer?.first.fill(0);
		answer?.second?.fill(0);
		wrapKey?.fill(0);
	}
};

export const retirePasskeyRecovery = async (
	{ key, locator }: { key: string; locator: string },
	deps: { tombstone: (locator: string) => Promise<void>; recordEntry: EnableDeps['recordEntry']; assertCurrent: () => void },
): Promise<void> => {
	try {
		deps.assertCurrent();
		await deps.tombstone(locator);
		deps.assertCurrent();
		await deps.recordEntry(key, null);
	} catch (e) {
		throw asRecoveryError(e);
	}
};
