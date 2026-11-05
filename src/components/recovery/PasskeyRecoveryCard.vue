<template>
	<div class="card mb-3 shadow-sm border-0 pk-card" data-test="passkey-recovery-card">
		<div class="card-body d-flex flex-column gap-2">
			<div class="d-flex align-items-center">
				<svg class="me-3" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#241824" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="7.5" cy="15.5" r="4.5"></circle>
					<path d="M10.7 12.3L21 2M16 7l3 3M18.5 4.5l2 2"></path>
				</svg>
				<h5 class="card-title mb-0 fw-bold">Recovery with passkey</h5>
			</div>

			<template v-if="loadError">
				<div class="text-secondary">
					Could not read the recovery settings: {{ loadError }}
					<button class="btn btn-link btn-sm p-0 ms-1 align-baseline" @click="load">Try again</button>
				</div>
			</template>

			<div v-else-if="!store.loaded" class="text-secondary">
				<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Loading…
			</div>

			<template v-else-if="!store.lock">
				<p class="card-text text-secondary mb-0" data-test="passkey-recovery-unavailable">
					Not available for this account on this device: its keys are locked with the older passkey method,
					which cannot restore an account. Keep a backup file, link another device or set up community backup.
				</p>
			</template>

			<template v-else-if="noPrf && !store.current">
				<p class="card-text text-secondary mb-0" data-test="passkey-recovery-no-prf">
					This browser or passkey provider cannot supply the PRF value needed for recovery here.
					Use a compatible passkey setup, or keep a backup file.
				</p>
			</template>

			<template v-else-if="store.current?.state === 'active'">
				<div data-test="passkey-recovery-on">
					<div class="fw-semibold">On for this account's passkey</div>
					<div class="text-secondary small">{{ store.current.label }} · since {{ dateOf(store.current.created_at) }}</div>
				</div>
				<div v-if="store.current.eligible === false" class="pk-warn" data-test="passkey-recovery-device-only">
					This passkey does not sync. Recovery will work after this browser's data is cleared, but not on a new device.
				</div>
				<div v-else-if="store.current.eligible == null" class="pk-warn" data-test="passkey-recovery-sync-unknown">
					Whether this passkey syncs could not be determined, so do not count on it on a new device. Recovery after
					this browser's data is cleared works on this device.
				</div>
				<div v-else-if="!store.current.synced" class="pk-warn" data-test="passkey-recovery-not-backed-up">
					This passkey has no confirmed backup yet, so do not count on it on another device. Recovery after this
					browser's data is cleared works on this device.
				</div>
				<div v-if="store.stale && !noPrf" class="pk-warn" data-test="passkey-recovery-stale">
					<div>
						The copy on the server was made before this account's backup changed, so it lacks what was added since.
						Updating asks for the passkey once.
					</div>
					<button class="btn btn-dark btn-sm mt-2" :disabled="busy" data-test="passkey-recovery-update" @click="enable">Update the copy</button>
				</div>
				<p class="card-text text-secondary small mb-0">
					Turning it off removes the copy from recovery. Earlier versions stay in the server's history, so this
					passkey can still open them: if the passkey is compromised, the account's keys have to be replaced.
				</p>
				<button class="btn btn-outline-dark" :disabled="busy" data-test="passkey-recovery-off" @click="withdraw(store.currentKey)">Turn off</button>
			</template>

			<template v-else-if="store.current?.state === 'pending'">
				<div class="pk-warn" data-test="passkey-recovery-pending">
					Setting up did not finish. The server may already hold the encrypted copy: finish it, or withdraw it.
				</div>
				<div class="d-flex gap-2">
					<button class="btn btn-outline-dark flex-fill" :disabled="busy" @click="withdraw(store.currentKey)">Withdraw</button>
					<button v-if="!noPrf" class="btn btn-dark flex-fill" :disabled="busy" @click="enable">Finish</button>
				</div>
			</template>

			<template v-else>
				<p class="card-text text-secondary mb-0">
					Keep an encrypted copy of your account on the server that only this account's passkey opens.
					If this browser's data is cleared — or on a new device your passkey syncs to — you can restore the
					account with the passkey alone. Whether this passkey and browser can do it is known only once the
					passkey answers: if it gives no PRF value, or this server does not let a device that is not signed in
					read the copy, nothing is stored.
				</p>
				<div class="pk-warn">
					<div class="fw-semibold">What changes</div>
					Today, taking over your account needs your passkey and this device. With this on, the passkey alone is
					enough, together with the copy anyone can fetch from the server. For a synced passkey that includes
					whoever controls the account of its provider (Apple, Google, a password manager) and can pass its
					verification.
				</div>
				<label class="form-check">
					<input v-model="understood" class="form-check-input" type="checkbox" data-test="passkey-recovery-consent" />
					<span class="form-check-label">I understand and want to turn it on</span>
				</label>
				<button class="btn btn-dark" :disabled="busy || !understood" data-test="passkey-recovery-on-button" @click="enable">Turn on</button>
			</template>

			<div v-if="rotationOffer" class="pk-warn" data-test="passkey-change-offer">
				<div class="fw-semibold">The new passkey now locks this device's vault</div>
				<p class="mb-2">To recover after this browser's data is cleared, turn on a copy for the new passkey using the consent above.</p>
				<p v-if="rotationOffer.oldCopy" class="mb-0">The previous passkey's recovery copy is still available. Once the new copy is on, you can choose whether to withdraw the old one.</p>
				<div v-if="rotationOffer.oldCopy && store.current?.state === 'active'" class="d-flex gap-2 mt-2">
					<button class="btn btn-outline-dark btn-sm" :disabled="busy" data-test="passkey-change-keep-old" @click="rotationOffer = null">Keep the old copy</button>
					<button class="btn btn-dark btn-sm" :disabled="busy" data-test="passkey-change-withdraw-old" @click="withdrawPrevious">Withdraw the old copy</button>
				</div>
			</div>

			<template v-if="store.loaded && !loadError && store.others.length">
				<div class="fw-semibold small mt-2">Copies for this account's other passkeys</div>
				<div class="text-secondary small" data-test="passkey-recovery-others-note">
					Each opens with the passkey that turned it on. This device can withdraw them, not renew them.
				</div>
				<div v-for="other in store.others" :key="other.key" class="d-flex align-items-center gap-2 small">
					<span class="flex-fill">{{ other.label }} · {{ dateOf(other.created_at) }}<span v-if="other.state === 'pending'"> · not finished</span></span>
					<button class="btn btn-sm btn-outline-dark" :disabled="busy" @click="withdraw(other.key)">Withdraw</button>
				</div>
			</template>

			<div v-if="store.loaded && store.lock && !noPrf" class="border-top pt-2 mt-2">
				<div class="fw-semibold small">Change this device's passkey</div>
				<p class="text-secondary small mb-2">A new passkey will lock this device's vault. Recovery copies are managed separately.</p>
				<button class="btn btn-outline-dark btn-sm" :disabled="busy" data-test="passkey-change-start" @click="changePasskey">Change passkey</button>
			</div>

			<div v-if="deviceBoundDecision" class="pk-warn" data-test="passkey-recovery-device-bound">
				<template v-if="deviceBoundDecision.reason === 'unknown'">
					<div class="fw-semibold">Could not determine whether this passkey syncs</div>
					The passkey did not report it. If it does not sync, the account can be restored with it on this device
					after this browser's data is cleared, but not on a new device: for that, keep a backup file or link
					another device. Nothing has been stored yet.
				</template>
				<template v-else>
					<div class="fw-semibold">This passkey does not sync</div>
					It stays on this device. If this browser's data is cleared, the account can be restored with it here,
					but not on a new device: for that, keep a backup file or link another device. Nothing has been stored yet.
				</template>
				<div class="d-flex gap-2 mt-2">
					<button class="btn btn-outline-dark btn-sm flex-fill" data-test="passkey-recovery-device-bound-cancel" @click="decide(false)">Cancel</button>
					<button class="btn btn-dark btn-sm flex-fill" data-test="passkey-recovery-device-bound-confirm" @click="decide(true)">
						{{ deviceBoundDecision.reason === 'unknown' ? 'Turn on anyway' : 'Turn on for this device' }}
					</button>
				</div>
			</div>

			<div v-if="notice" class="text-secondary small" data-test="passkey-recovery-notice">{{ notice }}</div>
			<div v-if="actionError" class="text-danger small" data-test="passkey-recovery-error">{{ actionError }}</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePasskeyRecoveryStore, passkeyRecoveryMessage } from '@/store/passkeyRecovery.store';
import errorMessage from '@/utils/errorMessage';
import type { DeviceBoundReason } from '@/lib/recovery/passkeyRecovery';

type RotationOffer = Awaited<ReturnType<ReturnType<typeof usePasskeyRecoveryStore>['changePasskey']>>;
interface DeviceBoundDecision {
	reason: DeviceBoundReason;
	resolve: (goOn: boolean) => void;
}

const store = usePasskeyRecoveryStore();
const busy = ref(false);
const understood = ref(false);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);
const rotationOffer = ref<RotationOffer | null>(null);
const deviceBoundDecision = ref<DeviceBoundDecision | null>(null);

const noPrf = computed(() => store.prfSupport === 'unsupported');

const dateOf = (seconds: number) => new Date(seconds * 1000).toLocaleDateString();

const load = async () => {
	loadError.value = null;
	try {
		await store.load();
	} catch (e) {
		loadError.value = errorMessage(e);
	}
};

const confirmDeviceBound = (reason: DeviceBoundReason) => new Promise<boolean>((resolve) => {
	deviceBoundDecision.value = { reason, resolve };
});

const decide = (goOn: boolean) => {
	const pending = deviceBoundDecision.value;
	deviceBoundDecision.value = null;
	pending?.resolve(goOn);
};

const act = async (run: () => Promise<unknown>) => {
	busy.value = true;
	actionError.value = null;
	notice.value = null;
	try {
		await run();
	} catch (e) {
		console.error('[passkey recovery]', e);
		const message = passkeyRecoveryMessage(e);
		actionError.value = message ? `${message[0]}. ${message[1]}` : errorMessage(e);
		await load();
	} finally {
		busy.value = false;
	}
};

const enable = () => act(async () => {
	if (!(await store.enable({ confirmDeviceBound }))) {
		notice.value = 'Not turned on. Nothing was stored.';
		return;
	}
	understood.value = false;
});
const withdraw = (key: string | null) => act(async () => {
	if (key) await store.withdraw(key);
});
const changePasskey = () => act(async () => {
	rotationOffer.value = await store.changePasskey();
	understood.value = false;
	notice.value = 'The vault now uses the new passkey. Its recovery copy has not been turned on.';
});
const withdrawPrevious = () => act(async () => {
	if (!rotationOffer.value?.oldKey || store.current?.state !== 'active') return;
	await store.withdraw(rotationOffer.value.oldKey);
	rotationOffer.value = null;
	notice.value = 'The previous passkey copy was withdrawn. Earlier encrypted versions may remain on the server.';
});

onMounted(() => {
	store.detectSupport();
	load();
});

onBeforeUnmount(() => decide(false));
</script>

<style lang="scss" scoped>
.pk-card {
	background-color: #f8f9fa;
	border-radius: 12px;
}
.pk-warn {
	padding: 10px 12px;
	border-radius: 8px;
	background: #fff4e5;
}
</style>
