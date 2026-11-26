<template>
	<div class="_storage_access mt-3" data-test="storage-access">
		<div class="fw-bold mb-2">Storage access</div>
		<div class="form-check form-switch mb-1">
			<input
				id="contact_storage_access"
				class="form-check-input"
				type="checkbox"
				role="switch"
				data-test="storage-access-toggle"
				:checked="checked"
				:disabled="!canToggle"
				@change="onToggle"
			/>
			<label class="form-check-label" for="contact_storage_access">Allow access through my permissions</label>
		</div>
		<div class="small opacity-75">
			Controls the storage access your account has granted this contact on the connected device. It does not remove the contact.
			Someone else who can grant access may still give them access.
		</div>
		<div class="small mt-2" data-test="storage-access-status">
			<span class="opacity-75">Status:</span> <span class="fw-bold">{{ confirmedLabel }}</span>
			<template v-if="pending">
				· <span class="fw-bold" data-test="storage-access-pending">{{ pending.granted ? 'Granting…' : 'Revoking…' }}</span>
			</template>
		</div>
		<div v-if="notice" class="small text-warning mt-1" data-test="storage-access-notice">{{ notice }}</div>
		<div v-if="error" class="small text-danger mt-1" data-test="storage-access-error">{{ error }}</div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, toRef } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useContactStorageAccess } from '@/composables/useContactStorageAccess';

interface SwalResult {
	isConfirmed: boolean;
}
interface Swal {
	fire: (options: Record<string, unknown>) => Promise<SwalResult>;
}
interface ContactAccessStore {
	currentUserHash: string | null;
	setContactStorageAccess: (issuerHash: string, userHash: string, granted: boolean, deviceId: string) => Promise<unknown>;
}

const props = defineProps<{ userHash: string }>();

const $userPQ = userPQStore() as unknown as ContactAccessStore;
const $swal = inject<Swal>('$swal');

const issuerHash = computed(() => $userPQ.currentUserHash ?? null);
const { view, error, context, stillIn, set } = useContactStorageAccess(
	issuerHash,
	toRef(props, 'userHash'),
	(issuer, subject, granted, deviceId) => $userPQ.setContactStorageAccess(issuer, subject, granted, deviceId),
);

const checked = computed(() => view.value.switchOn);
const canToggle = computed(() => view.value.canChange);
const pending = computed(() => view.value.pending);

const confirmedLabel = computed(() => {
	switch (view.value.confirmed) {
		case 'loading':
			return 'Loading…';
		case 'unavailable':
			return 'Unavailable';
		case 'granted':
			return view.value.inEffect === false ? 'Granted, not in effect' : 'Granted';
		case 'revoked':
			return 'Revoked';
		case 'not-granted':
			return 'Not granted';
		case 'partial':
			return view.value.partialScope === 'read' ? 'Partial: read only' : 'Partial: write only';
		default:
			return 'Unknown';
	}
});

const NOTICES: Record<string, string> = {
	unavailable: 'The access state could not be loaded from the connected device.',
	unverified: 'An access record could not be verified, so its state is not shown.',
	'no-owner': 'This device has no owner yet, so no storage access can be granted on it.',
	'grant-not-in-effect': 'Your account holds no storage access on this device, so this grant gives the contact nothing.',
	'cannot-grant': 'Your account holds no storage access on this device, so it cannot grant any.',
	'last:skipped:not-vouched': 'Your last request to grant access was not carried out: your account holds no storage access on this device to pass on.',
	'last:skipped:no-owner': 'Your last request was not carried out: this device has no owner.',
	'last:skipped:device-changed': 'Your last request was made for another device and was not applied here.',
	'last:overridden': 'Your last request was replaced by a newer change from your account.',
};

const notice = computed(() => (view.value.notice ? NOTICES[view.value.notice] ?? null : null));

const onToggle = async (event: Event) => {
	const input = event.target as HTMLInputElement;
	const granted = input.checked;
	input.checked = checked.value;
	const target = context();
	if (!canToggle.value || !target) return;
	if (!granted) {
		const answer = await $swal?.fire({
			icon: 'warning',
			title: 'Revoke storage access?',
			text: 'The storage access your account granted this contact on the connected device is withdrawn. The contact stays in your list.',
			showConfirmButton: true,
			showCancelButton: true,
			confirmButtonText: 'Revoke',
			cancelButtonText: 'Cancel',
		});
		if (!answer?.isConfirmed || !stillIn(target)) return;
	}
	await set(granted, target);
};
</script>

<style lang="scss" scoped>
._storage_access {
	text-align: left;
}
</style>
