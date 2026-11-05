// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive, ref } from 'vue';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import { createPrfPasskey } from '@buckitup/pq-client/vaultLock';
import { VaultLookupError } from '@/lib/recovery/vault';
import { ShapeReadError } from '@/lib/data/shapeRead';
import { TransportError } from '@buckitup/pq-client/transport';
import { PrfMissingError } from '@buckitup/pq-client/vaultLock';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import { prfAuthenticator } from './helpers/prfAuthenticator';
import type { Mock } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import type { PrfLockRecord } from '@buckitup/pq-client/vaultLock';
import type { BackupContents } from '@/lib/backupContents';
import type { PasskeyEnvelopeEntry, Recovered } from '@/lib/recovery/passkeyRecovery';

type Slot = { passkeys?: Record<string, Partial<PasskeyEnvelopeEntry>>; [field: string]: unknown } | null;

const passkeysOf = (slot: Slot): Record<string, Partial<PasskeyEnvelopeEntry>> => slot?.passkeys ?? {};

interface FakeScope {
	userHash: string;
	assertCurrent: () => void;
	pinned: <T>(run: () => Promise<T>) => Promise<T>;
	vaultLock: () => Promise<PrfLockRecord | null>;
	passkeyFlags: () => Promise<FakeManager['flags']>;
	readSlot: () => Promise<Slot>;
	patchSlot: (patch: Record<string, unknown>) => Promise<Slot>;
	publish: (wrapKey: Uint8Array, json: string) => Promise<string>;
	tombstone: (locator: string) => Promise<void>;
}

interface FakeManager {
	current: string;
	flags?: { backupEligible: boolean; backupState: boolean } | null;
	switchTo(userHash: string): void;
	passkeyRecoveryScope(): FakeScope;
	loadSlotJson: (...args: unknown[]) => Promise<unknown>;
	setSlot: (value: Slot) => void;
	slotOf: (userHash: string) => Slot;
}

interface FakeUser {
	currentUserHash: string | null;
	exportBackup: () => Promise<BackupContents>;
	getMyUserByHash: (userHash: string) => unknown;
	hasLocalVault: Mock<(userHash: string) => Promise<boolean>>;
	login: Mock<(...args: unknown[]) => Promise<unknown>>;
	importBackup: Mock<(...args: any[]) => Promise<unknown>>;
	changePasskey?: Mock<() => Promise<unknown>>;
}

interface Hoisted {
	em: FakeManager;
	user: FakeUser;
	fetchVault: (wrapKey: Uint8Array) => Promise<BackupContents>;
	readable: (wrapKey: Uint8Array) => Promise<void>;
	communityBackup: unknown;
}

const H = vi.hoisted(() => ({}) as Hoisted);
vi.mock('@/utils/downloadFile', () => ({ default: () => {} }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => H.em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('@/lib/recovery/vault', async () => {
	const actual = await vi.importActual<typeof import('@/lib/recovery/vault')>('@/lib/recovery/vault');
	return { ...actual, fetchVault: (key: Uint8Array) => H.fetchVault(key), assertVaultReadableAnonymously: (key: Uint8Array) => H.readable(key) };
});
vi.mock('@/lib/backupContents', async () => {
	const actual = await vi.importActual<typeof import('@/lib/backupContents')>('@/lib/backupContents');
	return { ...actual, assertBackupConsistent: () => {} };
});

const { fingerprintOf } = await import('@/lib/recovery/passkeyRecovery');
const { default: Card } = await import('@/components/recovery/PasskeyRecoveryCard.vue');
const { default: RestoreButton } = await import('@/components/recovery/PasskeyRestoreButton.vue');
const { default: AccountBackup } = await import('@/components/Account_Backup.vue');
const { default: Reminder } = await import('@/components/PasskeyRecoveryReminder.vue');
const { _setStoreForTests } = await import('@/lib/data/localStore');
const { markFileBackupMade, reminderDismissed, dismissReminder, announceBackupMade, announceBackupRemoved } = await import('@/lib/recovery/backupReminder');
const { useLocalBackupExport } = await import('@/composables/useLocalBackupExport');
const { usePasskeyRecoveryStore } = await import('@/store/passkeyRecovery.store');

const BACKUP = { version: 1, identity: { user_hash: 'u_alice', name: 'Alice' }, keys: { sign_skey: 's' } };

let auth: ReturnType<typeof prfAuthenticator>;
let lock: PrfLockRecord;
let published: { account: string; backup: BackupContents }[];
let tombstoned: string[];

const fakeManager = ({ prf = true } = {}) => {
	const slots = new Map<string, Slot>();
	let session = 0;
	const em: FakeManager = {
		current: 'u_alice',
		switchTo(userHash: string) {
			em.current = userHash;
			session++;
			H.user.currentUserHash = userHash;
		},
		passkeyRecoveryScope() {
			const userHash = em.current;
			const pinnedSession = session;
			const assertCurrent = () => {
				if (em.current !== userHash || session !== pinnedSession) throw new SessionFencedError('passkey recovery: the account changed; nothing more was written');
			};
			const pinned = async <T>(run: () => Promise<T>): Promise<T> => {
				assertCurrent();
				const result = await run();
				assertCurrent();
				return result;
			};
			return {
				userHash,
				assertCurrent,
				pinned,
				vaultLock: () => pinned(async () => (prf ? lock : null)),
				passkeyFlags: () => pinned(async () => em.flags ?? null),
				readSlot: () => pinned(async () => slots.get(userHash) ?? null),
				patchSlot: (patch: Record<string, unknown>) => pinned(async () => {
					const next = stripPatchDirectives(mergeJsonPatch(slots.get(userHash) ?? null, patch)) as Slot;
					slots.set(userHash, next);
					return next;
				}),
				publish: (_wrapKey: Uint8Array, json: string) => pinned(async () => {
					published.push({ account: userHash, backup: JSON.parse(json) });
					return 'uuid';
				}),
				tombstone: (locator: string) => pinned(async () => { tombstoned.push(locator); }),
			};
		},
		loadSlotJson: async () => H.communityBackup,
		setSlot: (value) => { slots.set(em.current, value); },
		slotOf: (userHash) => slots.get(userHash) ?? null,
	};
	return em;
};

const backupOf = (userHash: string): BackupContents => ({ ...BACKUP, identity: { ...BACKUP.identity, user_hash: userHash } });

beforeEach(async () => {
	setActivePinia(createPinia());
	auth = prfAuthenticator('at-create');
	vi.stubGlobal('navigator', { credentials: auth.credentials, platform: 'Linux' });
	({ record: lock } = await createPrfPasskey(auth.credentials, { rpId: 'localhost', vaultId: 'v1', name: 'Alice' }));
	published = [];
	tombstoned = [];
	H.em = fakeManager();
	H.communityBackup = null;
	H.readable = async () => {};
	H.user = {
		currentUserHash: 'u_alice',
		exportBackup: async () => backupOf(H.em.current),
		getMyUserByHash: () => undefined,
		hasLocalVault: vi.fn(async () => false),
		login: vi.fn(async () => ({})),
		importBackup: vi.fn(async () => ({ status: 'active', userHash: 'u_alice' })),
	};
});

afterEach(() => vi.unstubAllGlobals());

const browserPrf = (prf: boolean | undefined, { platformAuthenticator = true } = {}) => vi.stubGlobal('PublicKeyCredential', {
	getClientCapabilities: prf === undefined ? undefined : async () => ({ 'extension:prf': prf }),
	isUserVerifyingPlatformAuthenticatorAvailable: async () => platformAuthenticator,
});

const t = (w: VueWrapper, sel: string) => w.find(`[data-test="${sel}"]`);

const entryFor = async (extra: Partial<PasskeyEnvelopeEntry> = {}, key: string | null = null) => {
	const { credentialKey } = await import('@/lib/recovery/passkeyRecovery');
	H.em.setSlot({ passkeys: { [key ?? credentialKey(lock.credentialId)]: { label: 'L', locator: 'loc-1', synced: true, eligible: true, created_at: 1, fingerprint: 'x', state: 'active', ...extra } } });
};

describe('the Security & Recovery card', () => {
	it('offers recovery for a new passkey and withdraws the old copy only after the person chooses it', async () => {
		await entryFor();
		const oldCredentialId = lock.credentialId;
		H.user.changePasskey = vi.fn(async () => {
			({ record: lock } = await createPrfPasskey(auth.credentials, { rpId: 'localhost', vaultId: 'v2', name: 'Alice' }));
			return { card: { vaultId: 'v2' }, oldCredentialId, newCredentialId: lock.credentialId };
		});
		const w = mount(Card);
		await flushPromises();
		await t(w, 'passkey-change-start').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-change-offer').exists()).toBe(true));
		expect(H.user.changePasskey).toHaveBeenCalledOnce();
		expect(tombstoned).toEqual([]);
		expect(t(w, 'passkey-change-withdraw-old').exists()).toBe(false);
		await t(w, 'passkey-recovery-consent').setValue(true);
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-change-withdraw-old').exists()).toBe(true));
		expect(tombstoned).toEqual([]);
		await t(w, 'passkey-change-withdraw-old').trigger('click');
		await vi.waitFor(() => expect(tombstoned).toEqual(['loc-1']));
	});

	it('says recovery is unavailable for a legacy vault, and offers nothing', async () => {
		H.em = fakeManager({ prf: false });
		const w = mount(Card);
		await flushPromises();
		expect(t(w, 'passkey-recovery-unavailable').exists()).toBe(true);
		expect(t(w, 'passkey-recovery-on-button').exists()).toBe(false);
	});

	it('turns on only after the person confirms the trade-off, and then shows it on', async () => {
		const w = mount(Card);
		await flushPromises();
		expect(w.text()).toContain('the passkey alone is');
		expect(t(w, 'passkey-recovery-on-button').attributes('disabled')).toBeDefined();
		await t(w, 'passkey-recovery-consent').setValue(true);
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-on').exists()).toBe(true));
		expect(published).toEqual([{ account: 'u_alice', backup: BACKUP }]);
		expect(t(w, 'passkey-recovery-on').text()).toContain('Passkey used on Linux');
		expect(auth.calls).toEqual(['create', 'get']);
	});

	describe('a passkey that cannot sync (BE = 0)', () => {
		beforeEach(async () => {
			auth = prfAuthenticator('at-create', { backupEligible: false, backupState: false });
			vi.stubGlobal('navigator', { credentials: auth.credentials });
			({ record: lock } = await createPrfPasskey(auth.credentials, { rpId: 'localhost', vaultId: 'v1', name: 'Alice' }));
		});

		const askedToConfirm = async () => {
			const w = mount(Card);
			await flushPromises();
			await t(w, 'passkey-recovery-consent').setValue(true);
			await t(w, 'passkey-recovery-on-button').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(true));
			return w;
		};

		it('is explained before anything is stored, after the general consent', async () => {
			const w = await askedToConfirm();
			const warning = t(w, 'passkey-recovery-device-bound').text();
			expect(warning).toContain('This passkey does not sync');
			expect(warning).toContain('not on a new device');
			expect(warning).toContain('Nothing has been stored yet');
			expect(auth.calls).toEqual(['create', 'get']);
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();
		});

		it('declined: nothing is stored, and the card can be tried again', async () => {
			const w = await askedToConfirm();
			await t(w, 'passkey-recovery-device-bound-cancel').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-notice').text()).toBe('Not turned on. Nothing was stored.'));
			expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(false);
			expect(t(w, 'passkey-recovery-error').exists()).toBe(false);
			expect(t(w, 'passkey-recovery-on-button').attributes('disabled')).toBeUndefined();
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();
			expect(auth.calls).toEqual(['create', 'get']);

			await t(w, 'passkey-recovery-on-button').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(true));
			expect(t(w, 'passkey-recovery-notice').exists()).toBe(false);
		});

		it('confirmed: the passkey is asked again, and recovery is on with the warning kept', async () => {
			const w = await askedToConfirm();
			await t(w, 'passkey-recovery-device-bound-confirm').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-on').exists()).toBe(true));
			expect(auth.calls).toEqual(['create', 'get', 'get']);
			expect(published).toEqual([{ account: 'u_alice', backup: BACKUP }]);
			expect(w.text()).toContain('This passkey does not sync');
			expect(t(w, 'passkey-recovery-device-only').exists()).toBe(true);
			expect(t(w, 'passkey-recovery-sync-unknown').exists()).toBe(false);
		});

		it('a second prompt dismissed after confirming writes nothing and says so', async () => {
			const w = await askedToConfirm();
			auth.refuseNext();
			await t(w, 'passkey-recovery-device-bound-confirm').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-error').text()).toContain('The passkey prompt was closed'));
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();
			expect(t(w, 'passkey-recovery-on-button').exists()).toBe(true);
		});

		it('leaving the card while it asks declines: nothing is stored', async () => {
			const w = await askedToConfirm();
			w.unmount();
			await flushPromises();
			expect(auth.calls).toEqual(['create', 'get']);
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();
		});
	});

	describe('a passkey whose assertion did not say whether it syncs', () => {
		beforeEach(() => {
			const get = auth.credentials.get;
			auth.credentials.get = async (options?: CredentialRequestOptions) => ({ ...(await get(options)), response: {} }) as unknown as PublicKeyCredential;
		});

		it('says sync could not be determined, not that the passkey does not sync, before anything is stored', async () => {
			const w = mount(Card);
			await flushPromises();
			await t(w, 'passkey-recovery-consent').setValue(true);
			await t(w, 'passkey-recovery-on-button').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(true));
			const warning = t(w, 'passkey-recovery-device-bound').text();
			expect(warning).toContain('Could not determine whether this passkey syncs');
			expect(warning).not.toContain('This passkey does not sync');
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();

			await t(w, 'passkey-recovery-device-bound-confirm').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-on').exists()).toBe(true));
			expect(t(w, 'passkey-recovery-sync-unknown').text()).toContain('could not be determined');
			expect(t(w, 'passkey-recovery-device-only').exists()).toBe(false);
			expect(t(w, 'passkey-recovery-not-backed-up').exists()).toBe(false);
		});

		it('declined: nothing is stored', async () => {
			const w = mount(Card);
			await flushPromises();
			await t(w, 'passkey-recovery-consent').setValue(true);
			await t(w, 'passkey-recovery-on-button').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(true));
			await t(w, 'passkey-recovery-device-bound-cancel').trigger('click');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-notice').exists()).toBe(true));
			expect(published).toEqual([]);
			expect(H.em.slotOf('u_alice')).toBeNull();
		});
	});

	it('turns on a passkey with no confirmed backup yet without asking, and promises nothing for another device', async () => {
		auth = prfAuthenticator('at-create', { backupEligible: true, backupState: false });
		vi.stubGlobal('navigator', { credentials: auth.credentials });
		({ record: lock } = await createPrfPasskey(auth.credentials, { rpId: 'localhost', vaultId: 'v1', name: 'Alice' }));
		const w = mount(Card);
		await flushPromises();
		await t(w, 'passkey-recovery-consent').setValue(true);
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-on').exists()).toBe(true));
		expect(t(w, 'passkey-recovery-device-bound').exists()).toBe(false);
		expect(auth.calls).toEqual(['create', 'get']);
		const note = t(w, 'passkey-recovery-not-backed-up').text();
		expect(note).toContain('no confirmed backup yet');
		expect(note).toContain('do not count on it on another device');
	});

	it('a dismissed prompt is said as such, and nothing is published', async () => {
		const w = mount(Card);
		await flushPromises();
		await t(w, 'passkey-recovery-consent').setValue(true);
		auth.refuseNext();
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-error').text()).toContain('The passkey prompt was closed'));
		expect(published).toEqual([]);
	});

	it('does not keep showing the old state when it cannot be read again after a failed action, and offers to retry', async () => {
		const w = mount(Card);
		await flushPromises();
		const realScope = H.em.passkeyRecoveryScope;
		let readable = true;
		H.em.passkeyRecoveryScope = () => {
			const scope = realScope();
			return { ...scope, readSlot: async () => (readable ? scope.readSlot() : Promise.reject(new Error('offline'))) };
		};
		await t(w, 'passkey-recovery-consent').setValue(true);
		auth.refuseNext();
		readable = false;
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(w.text()).toContain('Could not read the recovery settings: offline'));
		expect(t(w, 'passkey-recovery-error').text()).toContain('The passkey prompt was closed');
		expect(t(w, 'passkey-recovery-on-button').exists()).toBe(false);

		readable = true;
		await w.findAll('button').find((b) => b.text() === 'Try again')!.trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-on-button').exists()).toBe(true));
		expect(w.text()).not.toContain('Could not read the recovery settings');
	});

	it('stops when another account is opened during the passkey prompt: nothing is sealed or listed for either', async () => {
		const w = mount(Card);
		await flushPromises();
		await t(w, 'passkey-recovery-consent').setValue(true);
		const get = auth.credentials.get;
		auth.credentials.get = async (o) => {
			H.em.switchTo('u_bob');
			return get(o);
		};
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-error').text()).toContain('Another account was opened meanwhile'));
		expect(published).toEqual([]);
		expect(H.em.slotOf('u_alice')).toBeNull();
		expect(H.em.slotOf('u_bob')).toBeNull();
	});

	it('refuses to start for state read under another account', async () => {
		const w = mount(Card);
		await flushPromises();
		H.em.switchTo('u_bob');
		await t(w, 'passkey-recovery-consent').setValue(true);
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-error').text()).toContain('Another account was opened meanwhile'));
		expect(auth.calls).toEqual(['create']);
		expect(published).toEqual([]);
	});

	it('is not turned on where a device that is not signed in cannot read the copy, and says why', async () => {
		H.readable = async () => { throw new ShapeReadError('user_storage', 401); };
		const w = mount(Card);
		await flushPromises();
		await t(w, 'passkey-recovery-consent').setValue(true);
		await t(w, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(w, 'passkey-recovery-error').text()).toContain('Passkey recovery does not work on this server'));
		expect(published).toEqual([]);
		expect(H.em.slotOf('u_alice')).toBeNull();
		expect(t(w, 'passkey-recovery-on').exists()).toBe(false);
	});

	describe('an enabled copy', () => {
		let key: string;
		const enabledEntry = async (fingerprint: string, extra: Partial<PasskeyEnvelopeEntry> = {}) => {
			({ credentialKey: key } = { credentialKey: (await import('@/lib/recovery/passkeyRecovery')).credentialKey(lock.credentialId) });
			H.em.setSlot({ passkeys: { [key]: { label: 'Laptop', locator: 'loc-1', synced: true, eligible: true, created_at: 1_700_000_000, fingerprint, state: 'active', ...extra } } });
		};

		it('is renewed on the person\'s action when the account exports keys it lacks, keeping its creation date', async () => {
			await enabledEntry(fingerprintOf(BACKUP));
			H.user.exportBackup = async () => ({ ...BACKUP, keys: { ...BACKUP.keys, meta_seed: 'ff' } });
			const w = mount(Card);
			await flushPromises();
			expect(t(w, 'passkey-recovery-stale').exists()).toBe(true);
			expect(auth.calls).toEqual(['create']);
			await t(w, 'passkey-recovery-update').trigger('click');
			await vi.waitFor(() => expect(published).toHaveLength(1));
			expect(published[0].backup.keys.meta_seed).toBe('ff');
			await vi.waitFor(() => expect(t(w, 'passkey-recovery-stale').exists()).toBe(false));
			expect(passkeysOf(H.em.slotOf('u_alice'))[key]).toMatchObject({ created_at: 1_700_000_000, state: 'active', fingerprint: fingerprintOf({ ...BACKUP, keys: { ...BACKUP.keys, meta_seed: 'ff' } }) });
			expect(auth.calls).toEqual(['create', 'get']);
		});

		it('says nothing while the account exports what the copy holds', async () => {
			await enabledEntry(fingerprintOf(BACKUP));
			const w = mount(Card);
			await flushPromises();
			expect(t(w, 'passkey-recovery-on').exists()).toBe(true);
			expect(t(w, 'passkey-recovery-stale').exists()).toBe(false);
			expect(auth.calls).toEqual(['create']);
		});

		it('can still be turned off where this browser has no PRF, and offers no renewal there', async () => {
			await enabledEntry(fingerprintOf(BACKUP));
			H.user.exportBackup = async () => ({ ...BACKUP, keys: { ...BACKUP.keys, meta_seed: 'ff' } });
			browserPrf(false);
			const w = mount(Card);
			await flushPromises();
			expect(t(w, 'passkey-recovery-off').exists()).toBe(true);
			expect(t(w, 'passkey-recovery-stale').exists()).toBe(false);
		});
	});

	it('is neither a legacy vault nor offered a switch where this browser has no PRF: it says so, and offers nothing', async () => {
		browserPrf(false);
		const w = mount(Card);
		await flushPromises();
		expect(t(w, 'passkey-recovery-no-prf').exists()).toBe(true);
		expect(t(w, 'passkey-recovery-unavailable').exists()).toBe(false);
		expect(t(w, 'passkey-recovery-on-button').exists()).toBe(false);
		expect(t(w, 'passkey-recovery-consent').exists()).toBe(false);
	});

	it('is offered while the browser cannot tell whether it does PRF', async () => {
		browserPrf(undefined, { platformAuthenticator: false });
		const w = mount(Card);
		await flushPromises();
		expect(t(w, 'passkey-recovery-on-button').exists()).toBe(true);
	});

	it('lists copies for other devices\' passkeys as such, to withdraw only', async () => {
		H.em.setSlot({ passkeys: { other: { label: 'Phone', locator: 'loc-2', synced: true, eligible: true, created_at: 1, state: 'active' } } });
		const w = mount(Card);
		await flushPromises();
		expect(t(w, 'passkey-recovery-others-note').text()).toContain('can withdraw them, not renew them');
		await w.findAll('button').find((b) => b.text() === 'Withdraw')!.trigger('click');
		await vi.waitFor(() => expect(tombstoned).toEqual(['loc-2']));
	});

	it('offers to finish or withdraw a setup left pending, and withdrawing tombstones the envelope', async () => {
		const { credentialKey } = await import('@/lib/recovery/passkeyRecovery');
		H.em.setSlot({ passkeys: { [credentialKey(lock.credentialId)]: { label: 'L', locator: 'loc-1', synced: true, eligible: true, created_at: 1, state: 'pending' } } });
		const w = mount(Card);
		await flushPromises();
		expect(t(w, 'passkey-recovery-pending').exists()).toBe(true);
		await w.findAll('button').find((b) => b.text() === 'Withdraw')!.trigger('click');
		await vi.waitFor(() => expect(tombstoned).toEqual(['loc-1']));
		await flushPromises();
		expect(t(w, 'passkey-recovery-pending').exists()).toBe(false);
	});
});

describe('the backup options reminder', () => {
	let router: { push: Mock };
	let closed: string[];
	const render = () => {
		router = { push: vi.fn() };
		closed = [];
		return mount(AccountBackup, { props: { showLocal: false }, global: { provide: { $swal: { fire: () => {} }, $mitt: { emit: (e: string) => closed.push(e) }, $router: router } } });
	};
	const offered = (w: VueWrapper) => w.find('[data-test="backup-option-passkey"]').exists();
	it('points a PRF vault without recovery at Security & Recovery, where the trade-off is read', async () => {
		const w = render();
		await flushPromises();
		expect(offered(w)).toBe(true);
		await t(w, 'backup-open-passkey-recovery').trigger('click');
		expect(closed).toEqual(['modal::close']);
		expect(router.push).toHaveBeenCalledWith({ name: 'account_backups' });
		expect(auth.calls).toEqual(['create']);
		expect(published).toEqual([]);
	});

	it.each([
		['a legacy vault', async () => { H.em = fakeManager({ prf: false }); }],
		['a browser without PRF', async () => { browserPrf(false); }],
		['recovery already on', async () => entryFor({})],
		['a passkey known to stay on this device', async () => entryFor({ state: 'pending', eligible: false, synced: false })],
	])('does not offer it for %s', async (_, arrange) => {
		await arrange();
		const w = render();
		await flushPromises();
		expect(offered(w)).toBe(false);
	});

	it('does not fail the reminder when the settings cannot be read', async () => {
		const onlineScope = H.em.passkeyRecoveryScope;
		H.em.passkeyRecoveryScope = () => ({ ...onlineScope(), vaultLock: async () => { throw new Error('offline'); }, readSlot: async () => null, passkeyFlags: async () => null });
		const w = render();
		await flushPromises();
		expect(offered(w)).toBe(false);
		expect(w.text()).toContain('Select your backup option');
	});
});

describe('the reminder to set up recovery', () => {
	let router: { push: Mock };
	let persisted: boolean;
	const memory = () => {
		const map = new Map<string, string>();
		return { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => { map.set(k, v); }, delete: async (k: string) => { map.delete(k); }, keys: async () => [...map.keys()], clear: async () => map.clear() };
	};
	let route: { name: string };
	const open = async () => {
		setActivePinia(createPinia());
		router = { push: vi.fn() };
		route = reactive({ name: 'chats' });
		const w = mount(Reminder, { global: { provide: { $router: router, $route: route } } });
		await flushPromises();
		return w;
	};
	const goTo = async (name: string) => {
		route.name = name;
		await flushPromises();
	};
	const holdLastRead = () => {
		const held: ((slot?: unknown) => void)[] = [];
		H.em.loadSlotJson = () => new Promise((resolve) => held.push((slot = null) => resolve(slot)));
		return held;
	};
	const saveFile = async () => {
		const { exportToFile, protect } = useLocalBackupExport();
		protect.value = false;
		expect(await exportToFile()).toBe(true);
	};
	const shown = (w: VueWrapper) => w.find('[data-test="passkey-recovery-reminder"]').exists();

	beforeEach(() => {
		persisted = false;
		_setStoreForTests(memory());
		vi.stubGlobal('navigator', { credentials: auth.credentials, platform: 'Linux', storage: { persisted: async () => persisted } });
	});

	it('is shown where the browser may clear its data and nothing backs the account up', async () => {
		const w = await open();
		expect(shown(w)).toBe(true);
		expect(w.text()).toContain('has no backup of it');
		expect(auth.calls).toEqual(['create']);
		expect(published).toEqual([]);
	});

	it('is shown for a passkey the sign-in found able to sync, too', async () => {
		H.em.flags = { backupEligible: true, backupState: true };
		expect(shown(await open())).toBe(true);
	});

	it('"Set it up" opens the Backup Center without saying "not now": back with nothing set up, it is shown again', async () => {
		const w = await open();
		await t(w, 'passkey-reminder-open').trigger('click');
		expect(router.push).toHaveBeenCalledWith({ name: 'account_backups' });
		await goTo('account_backups');
		expect(shown(w)).toBe(false);
		expect(await reminderDismissed('u_alice')).toBe(false);
		await goTo('chats');
		expect(shown(w)).toBe(true);
		expect(shown(await open())).toBe(true);
	});

	it('goes as soon as a backup file is saved, in the same session, and stays gone on the way back', async () => {
		const w = await open();
		await t(w, 'passkey-reminder-open').trigger('click');
		await goTo('account_backups');
		await saveFile();
		await goTo('chats');
		expect(shown(w)).toBe(false);
		expect(shown(await open())).toBe(false);
	});

	it('goes from the screen when a file is saved while it is shown', async () => {
		const w = await open();
		expect(shown(w)).toBe(true);
		await saveFile();
		await flushPromises();
		expect(shown(w)).toBe(false);
	});

	it('goes when a community backup is registered or passkey recovery is turned on in this session', async () => {
		const { announceBackupMade } = await import('@/lib/recovery/backupReminder');
		const w = await open();
		announceBackupMade('u_alice', 'community');
		await flushPromises();
		expect(shown(w)).toBe(false);

		const again = await open();
		expect(shown(again)).toBe(true);
		const card = mount(Card);
		await flushPromises();
		await t(card, 'passkey-recovery-consent').setValue(true);
		await t(card, 'passkey-recovery-on-button').trigger('click');
		await vi.waitFor(() => expect(t(card, 'passkey-recovery-on').exists()).toBe(true));
		expect(shown(again)).toBe(false);
	});

	it('a check still under way when a file is saved, "Not now" is said or the Backup Center is opened shows nothing', async () => {
		for (const act of [
			async () => saveFile(),
			async (w: VueWrapper) => t(w, 'passkey-reminder-dismiss').trigger('click'),
			async (w: VueWrapper) => t(w, 'passkey-reminder-open').trigger('click'),
		]) {
			H.em = fakeManager();
			_setStoreForTests(memory());
			const w = await open();
			const held = holdLastRead();
			await goTo('account_backups');
			await goTo('chats');
			expect(held).toHaveLength(1);
			await act(w);
			held[0]();
			await flushPromises();
			expect(shown(w)).toBe(false);
		}
	});

	it('an older check of the account does not overrule a newer one', async () => {
		const w = await open();
		const store = usePasskeyRecoveryStore();
		const held = holdLastRead();
		const older = store.checkReminder();
		await flushPromises();
		H.communityBackup = { run: { step: 'done', secretId: 'eip155:1:0xabc/1' } };
		H.em.loadSlotJson = async () => H.communityBackup;
		await store.checkReminder();
		held[0]();
		await older;
		expect(shown(w)).toBe(false);
	});

	it('the result of a check for one account is never shown for another', async () => {
		H.user = reactive(H.user);
		const w = await open();
		expect(shown(w)).toBe(true);
		const store = usePasskeyRecoveryStore();
		const held = holdLastRead();
		const forAlice = store.checkReminder();
		await flushPromises();
		H.em.switchTo('u_bob');
		await flushPromises();
		expect(shown(w)).toBe(false);
		expect(held).toHaveLength(2);
		held[1]({ run: { step: 'done', secretId: 'eip155:1:0xabc/1' } });
		await flushPromises();
		held[0]();
		await forAlice;
		await flushPromises();
		expect(shown(w)).toBe(false);
		expect(store.reminderDue).toBe(false);
	});

	describe('after the last backup is removed in the same session', () => {
		const turnedOn = async () => {
			const card = mount(Card);
			await flushPromises();
			await t(card, 'passkey-recovery-consent').setValue(true);
			await t(card, 'passkey-recovery-on-button').trigger('click');
			await vi.waitFor(() => expect(t(card, 'passkey-recovery-on').exists()).toBe(true));
			return card;
		};
		const turnOff = async (card: VueWrapper) => {
			await t(card, 'passkey-recovery-off').trigger('click');
			await vi.waitFor(() => expect(t(card, 'passkey-recovery-on').exists()).toBe(false));
			await flushPromises();
		};
		const registered = { run: { step: 'done', secretId: 'eip155:1:0xabc/1' } };

		it('comes back once the last passkey copy is turned off', async () => {
			const w = await open();
			const card = await turnedOn();
			expect(shown(w)).toBe(false);
			await turnOff(card);
			expect(tombstoned).toHaveLength(1);
			expect(shown(w)).toBe(true);
		});

		it('stays away while a copy under another passkey is still on', async () => {
			await entryFor({ locator: 'loc-2' }, 'other-key');
			const w = await open();
			expect(shown(w)).toBe(false);
			await turnOff(await turnedOn());
			expect(shown(w)).toBe(false);
		});

		it('stays away once a backup file was saved, or "Not now" said: a removal does not undo either', async () => {
			const cases: [(w: VueWrapper) => Promise<unknown>, boolean][] = [[saveFile, false], [async (w: VueWrapper) => t(w, 'passkey-reminder-dismiss').trigger('click'), false]];
			for (const [arrange, again] of cases) {
				H.em = fakeManager();
				_setStoreForTests(memory());
				const w = await open();
				await arrange(w);
				await turnOff(await turnedOn());
				expect(shown(w)).toBe(false);
				expect(shown(await open())).toBe(again);
			}
		});

		it('stays away when turning the copy off failed: the copy is still there', async () => {
			const w = await open();
			const card = await turnedOn();
			const realScope = H.em.passkeyRecoveryScope;
			H.em.passkeyRecoveryScope = () => ({ ...realScope(), tombstone: async () => { throw new Error('offline'); } });
			await t(card, 'passkey-recovery-off').trigger('click');
			await vi.waitFor(() => expect(t(card, 'passkey-recovery-error').exists()).toBe(true));
			await flushPromises();
			expect(t(card, 'passkey-recovery-on').exists()).toBe(true);
			expect(shown(w)).toBe(false);
		});

		it('comes back once a community backup, the only one, is revoked; not while a file or a copy is left', async () => {
			H.communityBackup = registered;
			const w = await open();
			expect(shown(w)).toBe(false);
			announceBackupMade('u_alice', 'community');
			H.communityBackup = { run: { ...registered.run, revokedAt: 1 } };
			announceBackupRemoved('u_alice', 'community');
			await flushPromises();
			expect(shown(w)).toBe(true);

			H.communityBackup = registered;
			const withFile = await open();
			await saveFile();
			H.communityBackup = { run: { ...registered.run, revokedAt: 1 } };
			announceBackupRemoved('u_alice', 'community');
			await flushPromises();
			expect(shown(withFile)).toBe(false);
		});

		it('a passkey copy turned on stays known when the community backup is revoked', async () => {
			H.communityBackup = registered;
			const w = await open();
			await turnedOn();
			H.communityBackup = null;
			announceBackupRemoved('u_alice', 'community');
			await flushPromises();
			expect(shown(w)).toBe(false);
		});

		it('the check a removal starts shows nothing once a file is saved meanwhile', async () => {
			const w = await open();
			const card = await turnedOn();
			const held = holdLastRead();
			await turnOff(card);
			expect(held).toHaveLength(1);
			await saveFile();
			held[0]();
			await flushPromises();
			expect(shown(w)).toBe(false);
		});

		it('the check a removal starts is never shown for another account signed in meanwhile', async () => {
			H.user = reactive(H.user);
			await dismissReminder('u_bob');
			const w = await open();
			const card = await turnedOn();
			const held = holdLastRead();
			await turnOff(card);
			H.em.switchTo('u_bob');
			await flushPromises();
			held[0]();
			await flushPromises();
			expect(shown(w)).toBe(false);
			expect(usePasskeyRecoveryStore().reminderDue).toBe(false);
		});
	});

	it('is dismissed with "Not now", and stays dismissed for that account only', async () => {
		const w = await open();
		await t(w, 'passkey-reminder-dismiss').trigger('click');
		expect(shown(w)).toBe(false);
		expect(shown(await open())).toBe(false);
		H.user.currentUserHash = 'u_bob';
		H.em.current = 'u_bob';
		expect(shown(await open())).toBe(true);
	});

	it.each([
		['the browser promised to keep its data', async () => { persisted = true; }],
		['the account has a community backup', async () => { H.communityBackup = { run: { step: 'done', secretId: 'eip155:1:0xabc/1' } }; }],
		['recovery is already on for this passkey', async () => entryFor({})],
		['recovery is on for another passkey of the account', async () => entryFor({ locator: 'loc-2' }, 'other-key')],
		['a backup file was made on this device', async () => markFileBackupMade('u_alice')],
		['the passkey is known to stay on this device', async () => { H.em.flags = { backupEligible: false, backupState: false }; }],
		['the vault is a legacy one', async () => { H.em = fakeManager({ prf: false }); }],
		['the browser has no PRF', async () => { browserPrf(false); }],
	])('is not shown when %s', async (_, arrange) => {
		await arrange();
		expect(shown(await open())).toBe(false);
	});

	it('is shown when only a revoked community backup or an unfinished setup is there', async () => {
		H.communityBackup = { run: { step: 'done', secretId: 'eip155:1:0xabc/1', revokedAt: 1 } };
		const { credentialKey } = await import('@/lib/recovery/passkeyRecovery');
		H.em.setSlot({ passkeys: { [credentialKey(lock.credentialId)]: { label: 'L', locator: 'loc-1', synced: true, eligible: true, created_at: 1, fingerprint: 'x', state: 'pending' } } });
		expect(shown(await open())).toBe(true);
	});

	it('says nothing when what it needs cannot be read', async () => {
		const onlineScope = H.em.passkeyRecoveryScope;
		H.em.passkeyRecoveryScope = () => ({ ...onlineScope(), vaultLock: async () => { throw new Error('offline'); }, readSlot: async () => null, passkeyFlags: async () => null });
		expect(shown(await open())).toBe(false);
		H.em = fakeManager();
		H.em.loadSlotJson = async () => { throw new Error('offline'); };
		expect(shown(await open())).toBe(false);
	});
});

describe('the login screen button', () => {
	let fired: { title: string }[];
	let asked: string[];
	let router: { replace: Mock };
	const render = ({ answer = true } = {}) => {
		fired = [];
		asked = [];
		router = { replace: vi.fn() };
		const provide = {
			$swal: { fire: (o: { title: string }) => fired.push(o) },
			$swalModal: ref({ open: async (o: { title: string }) => { asked.push(o.title); return answer; } }),
			$mitt: { emit: () => {} },
			$router: router,
		};
		return mount(RestoreButton, { global: { provide } });
	};

	it('is shown although no platform authenticator is available: a phone or a password manager can answer', async () => {
		browserPrf(undefined, { platformAuthenticator: false });
		const w = render();
		await flushPromises();
		expect(t(w, 'restore-with-passkey').exists()).toBe(true);
		browserPrf(true, { platformAuthenticator: false });
		const again = render();
		await flushPromises();
		expect(t(again, 'restore-with-passkey').exists()).toBe(true);
	});

	it('is not shown where the browser says it has no PRF', async () => {
		browserPrf(false);
		const w = render();
		await flushPromises();
		expect(t(w, 'restore-with-passkey').exists()).toBe(false);
	});

	it('restores into a new vault locked by the passkey that answered', async () => {
		let seenKey = null;
		H.fetchVault = async (key) => { seenKey = new Uint8Array(key); return BACKUP; };
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(H.user.importBackup).toHaveBeenCalledTimes(1));
		expect(seenKey).toHaveLength(32);
		const [backup, { lock: prepared }] = H.user.importBackup.mock.calls[0];
		expect(backup.identity.user_hash).toBe('u_alice');
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(prepared.lock.salt).not.toBe(lock.salt);
		expect(auth.calls.filter((c) => c === 'create')).toHaveLength(1);
		expect(fired).toEqual([]);
	});

	it.each([
		['absent', () => new VaultLookupError('none', 'absent'), 'No passkey recovery on this server'],
		['HTTP 401', () => new ShapeReadError('user_storage', 401), 'Passkey recovery does not work on this server'],
		['a network failure', () => new TransportError('/shapes: no answer (Failed to fetch)', { network: true }), 'The server did not answer'],
		['a timeout', () => new DOMException('timed out', 'TimeoutError'), 'The server did not answer'],
		['a failed fetch', () => new TypeError('Failed to fetch'), 'The server did not answer'],
		['a passkey without PRF', () => new PrfMissingError(), 'This passkey cannot restore on this device'],
		['a dismissed prompt', () => new DOMException('cancelled', 'NotAllowedError'), 'The passkey prompt was closed'],
	])('%s gets its own message and imports nothing', async (_, failure, title) => {
		H.fetchVault = async () => { throw failure(); };
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(fired.map((f) => f.title)).toEqual([title]));
		expect(H.user.importBackup).not.toHaveBeenCalled();
	});

	it.each([
		['a browser that refuses the PRF request', () => new TypeError('prf'), 'This passkey cannot restore on this device'],
		['a refused passkey request', () => new DOMException('rp', 'SecurityError'), 'The passkey request failed'],
		['a passkey request that timed out', () => new DOMException('slow', 'TimeoutError'), 'The passkey request failed'],
	])('%s is reported as the passkey\'s failure, not the server\'s', async (_, failure, title) => {
		H.fetchVault = vi.fn(async () => BACKUP);
		auth.credentials.get = async () => { throw failure(); };
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(fired.map((f) => f.title)).toEqual([title]));
		expect(H.fetchVault).not.toHaveBeenCalled();
		expect(H.user.importBackup).not.toHaveBeenCalled();
	});

	it('wipes the prepared lock seed when the import fails', async () => {
		H.fetchVault = async () => BACKUP;
		let seed: Uint8Array | null = null;
		H.user.importBackup = vi.fn(async (_: unknown, { lock: prepared }: { lock: { seed: Uint8Array } }) => { seed = prepared.seed; throw new Error('card rejected'); });
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(fired.map((f) => f.title)).toEqual(['The account could not be restored']));
		expect(seed!.every((b) => b === 0)).toBe(true);
	});

	it('for an account whose keys are here, offers the ordinary sign-in instead of replacing it', async () => {
		H.fetchVault = async () => BACKUP;
		H.user.getMyUserByHash = () => ({ user_hash: 'u_alice' });
		H.user.hasLocalVault = vi.fn(async () => true);
		const { usePasskeyRecoveryStore } = await import('@/store/passkeyRecovery.store');
		const store = usePasskeyRecoveryStore();
		const recover = store.recover;
		let found: Recovered | null = null;
		store.recover = async () => (found = await recover());
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(H.user.login).toHaveBeenCalledWith('u_alice'));
		expect(asked).toEqual(['This account is already on this device']);
		expect(H.user.importBackup).not.toHaveBeenCalled();
		expect(router.replace).toHaveBeenCalledWith({ name: 'account_info' });
		await flushPromises();
		expect(found!.prepared.seed.every((b) => b === 0)).toBe(true);
		expect(fired).toEqual([]);
	});

	it('for an account whose keys are here, signs in to nothing when the person declines', async () => {
		H.fetchVault = async () => BACKUP;
		H.user.hasLocalVault = vi.fn(async () => true);
		const w = render({ answer: false });
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(asked).toEqual(['This account is already on this device']));
		await flushPromises();
		expect(H.user.login).not.toHaveBeenCalled();
		expect(H.user.importBackup).not.toHaveBeenCalled();
	});

	it('for an account listed here without its keys, restores them without asking to replace anything', async () => {
		H.fetchVault = async () => BACKUP;
		H.user.getMyUserByHash = () => ({ user_hash: 'u_alice' });
		const w = render();
		await t(w, 'restore-with-passkey').trigger('click');
		await vi.waitFor(() => expect(H.user.importBackup).toHaveBeenCalledTimes(1));
		expect(asked).toEqual([]);
	});
});
