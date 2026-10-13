<template>
	<!-- A live recovery of the owner's own backup: over every screen, until it ends or the owner says it is theirs. -->
	<div v-if="alert" :key="alert.secretId + ':' + alert.round" class="_recovery_alert" role="alert">
		<div class="fw-semibold">⚠️ {{ text.title }}</div>
		<div class="small">{{ text.body }}</div>
		<div v-if="$rounds.lastError" class="small _recovery_alert_error">{{ $rounds.lastError }}</div>
		<div class="d-flex gap-2 mt-2">
			<button type="button" class="btn btn-sm btn-danger" :disabled="$rounds.stopping === alert.secretId" @click="stop(alert)">
				{{ $rounds.stopping === alert.secretId ? 'Stopping…' : 'Stop it' }}
			</button>
			<button type="button" class="btn btn-sm btn-outline-light" :disabled="$rounds.stopping === alert.secretId" @click="itsMe(alert)">It's me</button>
		</div>
	</div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useRecoveryRoundsStore } from '@/store/recoveryRounds.store';
import { alertText } from '@/lib/recovery/rounds';

const $rounds = useRecoveryRoundsStore();
const $swal = inject('$swal');

const alert = computed(() => $rounds.shown);

// The countdown in the text moves on its own, a minute at a time, while there is one.
const now = ref(Math.floor(Date.now() / 1000));
let tick = null;
const stopTicking = () => {
	clearInterval(tick);
	tick = null;
};
watch(
	alert,
	(a) => {
		if (!a) return stopTicking();
		now.value = Math.floor(Date.now() / 1000);
		tick ??= setInterval(() => (now.value = Math.floor(Date.now() / 1000)), 60_000);
	},
	{ immediate: true },
);
onBeforeUnmount(stopTicking);

const text = computed(() => alertText(alert.value, now.value));

const stop = (a) => $rounds.stop(a).catch(() => undefined);

const itsMe = async (a) => {
	const { isConfirmed } = await $swal.fire({
		icon: 'warning',
		title: 'Is this recovery yours?',
		text: 'Only if you started it yourself, from a new device. If you hide this and it is not you, someone else gets into your account.',
		showCancelButton: true,
		confirmButtonText: 'Yes, it is me',
		cancelButtonText: 'Back',
	});
	if (isConfirmed) $rounds.acknowledge(a);
};
</script>

<style scoped>
._recovery_alert {
	background: #b02a37;
	color: #fff;
	padding: 10px 14px;
}
._recovery_alert_error {
	color: #ffd7db;
	margin-top: 4px;
}
</style>
