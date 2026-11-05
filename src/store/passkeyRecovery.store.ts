import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { userPQStore } from '@/store/userPQ.store';
import { fetchVault, assertVaultReadableAnonymously } from '@/lib/recovery/vault';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import {
	credentialKey, enablePasskeyRecovery, recoverWithPasskey, retirePasskeyRecovery, recoveryFailureOf,
	fingerprintOf, isCopyStale, detectPrfSupport,
	type PasskeyEnvelopeEntry, type PasskeyRecoveryFailure, type PrfSupport, type DeviceBoundReason, type Recovered,
} from '@/lib/recovery/passkeyRecovery';
import type { PrfLockRecord } from '@buckitup/pq-client/vaultLock';
import type { BackupContents } from '@/lib/backupContents';
import { registeredSecretOf } from '@/lib/recovery/backupRun';
import {
	browserDataMayBeCleared, reminderDismissed, dismissReminder, fileBackupMade, onBackupChange,
	type BackupKind, type BackupChange,
} from '@/lib/recovery/backupReminder';
import { BACKUP_SLOT } from '@/store/recoveryBackup.store';

type PasskeyEntries = Record<string, PasskeyEnvelopeEntry>;
type PasskeyFlags = { backupEligible: boolean; backupState: boolean } | null;

interface PasskeyRecoverySlot {
	passkeys?: PasskeyEntries;
}

interface PasskeyRecoveryScope {
	userHash: string;
	assertCurrent: () => void;
	pinned: <T>(run: () => Promise<T>) => Promise<T>;
	vaultLock: () => Promise<PrfLockRecord | null>;
	passkeyFlags: () => Promise<PasskeyFlags>;
	readSlot: () => Promise<PasskeyRecoverySlot | null>;
	patchSlot: (patch: Record<string, unknown>) => Promise<PasskeyRecoverySlot | null>;
	publish: (wrapKey: Uint8Array, json: string) => Promise<string>;
	tombstone: (locator: string) => Promise<void>;
}

export const PASSKEY_RECOVERY_MESSAGES: Record<PasskeyRecoveryFailure, [title: string, text: string]> = {
	cancelled: ['The passkey prompt was closed', 'It was dismissed or timed out. Nothing was changed.'],
	'no-prf': ['This passkey cannot restore on this device', 'The browser or passkey provider did not return the PRF value needed for recovery. The same saved passkey may behave differently on another device. Use a backup file, another device or your guardians.'],
	'wrong-passkey': ['Another passkey answered', 'Choose the passkey this account is locked with.'],
	absent: ['No passkey recovery on this server', 'Recovery with this passkey was not set up on this server, or it was turned off.'],
	foreign: ['No passkey recovery on this server', 'Something is stored at this passkey\'s address, but it is not a backup this passkey opens.'],
	unauthorized: ['Passkey recovery does not work on this server', 'It lets only signed-in accounts read stored data (access mode trust), and a device restoring with a passkey is not signed in. Nothing was stored or read. Use a backup file or another device.'],
	network: ['The server did not answer', 'Check the connection and try again — this does not mean there is no backup.'],
	server: ['The server returned an error', 'Try again later — this does not mean there is no backup.'],
	invalid: ['The backup is not usable', 'Its keys do not belong to the account it names. Nothing was stored or imported.'],
	'account-changed': ['Another account was opened meanwhile', 'The operation stopped before its next write. Open the account again and retry.'],
	'passkey-failed': ['The passkey request failed', 'The browser refused it, and nothing was stored or changed. Try again; if it keeps failing, use a backup file, another device or your guardians.'],
};

export const passkeyRecoveryMessage = (error: unknown): [title: string, text: string] | null => {
	const failure = recoveryFailureOf(error);
	return failure ? PASSKEY_RECOVERY_MESSAGES[failure] : null;
};

type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } };

const deviceLabel = (): string => {
	const platform = typeof navigator !== 'undefined'
		? ((navigator as NavigatorWithUserAgentData).userAgentData?.platform || navigator.platform)
		: '';
	return platform ? `Passkey used on ${platform}` : 'Passkey';
};

export const usePasskeyRecoveryStore = defineStore('passkeyRecovery', () => {
	const recoveryScope = (): PasskeyRecoveryScope => {
		const { userHash, ...scope } = EncryptionManagerPQ.getInstance().passkeyRecoveryScope();
		if (!userHash) throw new SessionFencedError('passkey recovery: no session for this account');
		return { ...scope, userHash };
	};
	const $userPQ = userPQStore();

	const owner = ref<string | null>(null);
	const lock = ref<PrfLockRecord | null>(null);
	const entries = ref<PasskeyEntries>({});
	const loaded = ref(false);
	const exportedFingerprint = ref<string | null>(null);
	const passkeyFlags = ref<PasskeyFlags>(null);
	const reminderDue = ref(false);
	const prfSupport = ref<PrfSupport>('unknown');

	const dismissedAccounts = new Set<string>();
	const backupsMade = new Map<string, Set<BackupKind>>();
	const quiet = (account: string) => dismissedAccounts.has(account) || (backupsMade.get(account)?.size ?? 0) > 0;
	let reminderCheck = 0;

	const currentKey = computed(() => (lock.value ? credentialKey(lock.value.credentialId) : null));
	const current = computed(() => (currentKey.value ? entries.value[currentKey.value] ?? null : null));
	const stale = computed(() => current.value?.state === 'active' && !!exportedFingerprint.value && isCopyStale(current.value, exportedFingerprint.value));
	const offerable = computed(() => loaded.value && !!lock.value && prfSupport.value !== 'unsupported'
		&& current.value?.state !== 'active' && current.value?.eligible !== false
		&& passkeyFlags.value?.backupEligible !== false);
	const others = computed(() => Object.entries(entries.value).filter(([key]) => key !== currentKey.value).map(([key, entry]) => ({ key, ...entry })));

	const reset = () => {
		owner.value = null;
		lock.value = null;
		entries.value = {};
		exportedFingerprint.value = null;
		passkeyFlags.value = null;
		reminderDue.value = false;
		loaded.value = false;
	};

	const detectSupport = async () => {
		prfSupport.value = await detectPrfSupport();
	};

	const readExportedFingerprint = async (scope: PasskeyRecoveryScope): Promise<string | null> => {
		try {
			return fingerprintOf(await scope.pinned<BackupContents>(() => $userPQ.exportBackup()));
		} catch {
			return null;
		}
	};

	const load = async () => {
		const scope = recoveryScope();
		const [vaultLock, slot, flags] = await Promise.all([scope.vaultLock(), scope.readSlot(), scope.passkeyFlags()]);
		const mine = vaultLock && slot?.passkeys?.[credentialKey(vaultLock.credentialId)];
		const fingerprint = mine?.state === 'active' ? await readExportedFingerprint(scope) : null;
		scope.assertCurrent();
		owner.value = scope.userHash;
		lock.value = vaultLock;
		entries.value = slot?.passkeys ?? {};
		passkeyFlags.value = flags;
		exportedFingerprint.value = fingerprint;
		loaded.value = true;
	};

	const scopeForLoaded = () => {
		const scope = recoveryScope();
		if (!loaded.value || owner.value !== scope.userHash) throw new SessionFencedError('passkey recovery: the account changed since its state was read');
		return scope;
	};

	const recorder = (scope: PasskeyRecoveryScope) => async (key: string, entry: PasskeyEnvelopeEntry | null): Promise<void> => {
		const accepted = await scope.patchSlot({ $keyed: ['passkeys'], passkeys: { [key]: entry } });
		if (owner.value === scope.userHash) entries.value = accepted?.passkeys ?? {};
	};

	const enable = async ({ confirmDeviceBound }: { confirmDeviceBound: (reason: DeviceBoundReason) => Promise<boolean> }) => {
		const scope = scopeForLoaded();
		const vaultLock = await scope.vaultLock();
		if (!vaultLock) throw new Error('This account\'s vault on this device is not locked with a PRF passkey');
		const result = await enablePasskeyRecovery({
			credentials: navigator.credentials,
			owner: scope.userHash,
			lock: vaultLock,
			label: current.value?.label ?? deviceLabel(),
			previous: current.value,
			assertCurrent: scope.assertCurrent,
			assertReadable: (wrapKey) => scope.pinned(() => assertVaultReadableAnonymously(wrapKey)),
			exportBackup: () => scope.pinned<BackupContents>(() => $userPQ.exportBackup()),
			publish: scope.publish,
			recordEntry: recorder(scope),
			confirmDeviceBound,
		});
		if (result?.entry.state === 'active') noteBackup(scope.userHash, 'passkey', 'made');
		return result;
	};

	const reminderIsDue = async (account: string | null): Promise<boolean> => {
		if (!account || quiet(account) || !(await browserDataMayBeCleared()) || await reminderDismissed(account)) return false;
		try {
			await Promise.all([load(), detectSupport()]);
			if (!offerable.value || Object.values(entries.value).some((entry) => entry.state === 'active')) return false;
			if (await fileBackupMade(account)) return false;
			return !registeredSecretOf(await EncryptionManagerPQ.getInstance().loadSlotJson(BACKUP_SLOT));
		} catch {
			return false;
		}
	};

	const checkReminder = async () => {
		const account = $userPQ.currentUserHash;
		const check = ++reminderCheck;
		const due = await reminderIsDue(account);
		if (check !== reminderCheck) return;
		reminderDue.value = due && !!account && $userPQ.currentUserHash === account && !quiet(account);
	};

	const hideReminder = () => {
		reminderCheck++;
		reminderDue.value = false;
	};

	const noteBackup = (account: string, kind: BackupKind, change: BackupChange) => {
		if (change === 'made') {
			const kinds = backupsMade.get(account) ?? new Set<BackupKind>();
			backupsMade.set(account, kinds);
			kinds.add(kind);
			if (account === $userPQ.currentUserHash) hideReminder();
			return;
		}
		backupsMade.get(account)?.delete(kind);
		if (account === $userPQ.currentUserHash) checkReminder().catch(() => {});
	};
	onBackupChange(noteBackup);

	const dismissReminderForNow = async () => {
		const account = $userPQ.currentUserHash;
		if (!account) return;
		dismissedAccounts.add(account);
		hideReminder();
		await dismissReminder(account);
	};

	const withdraw = async (key: string) => {
		const scope = scopeForLoaded();
		const entry = entries.value[key];
		if (!entry) return;
		await retirePasskeyRecovery({ key, locator: entry.locator }, { tombstone: scope.tombstone, recordEntry: recorder(scope), assertCurrent: scope.assertCurrent });
		noteBackup(scope.userHash, 'passkey', 'removed');
	};

	const changePasskey = async () => {
		scopeForLoaded();
		const oldKey = currentKey.value;
		const result = await $userPQ.changePasskey();
		await load();
		return { ...result, oldKey, oldCopy: oldKey ? entries.value[oldKey] ?? null : null };
	};

	const recover = (): Promise<Recovered> => recoverWithPasskey({ credentials: navigator.credentials, rpId: location.hostname, fetchVault });

	watch(() => $userPQ.currentUserHash, reset);

	return {
		owner, lock, entries, loaded, current, currentKey, others, stale, offerable, prfSupport, passkeyFlags, reminderDue,
		detectSupport, load, enable, withdraw, changePasskey, recover, checkReminder, hideReminder, dismissReminder: dismissReminderForNow,
	};
});
