<template>
	<!-- A live recovery of the owner's own backup: over every screen, until it ends or the owner says it is theirs. -->
	<div v-for="alert in $rounds.shown" :key="alert.secretId + ':' + alert.round" class="_recovery_alert" role="alert">
		<div class="fw-semibold">⚠️ {{ text(alert).title }}</div>
		<div class="small">{{ text(alert).body }}</div>
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
import { inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRecoveryRoundsStore } from '@/store/recoveryRounds.store';
import { alertText } from '@/lib/recovery/rounds';

const $rounds = useRecoveryRoundsStore();
const $swal = inject('$swal', null);

// The countdown in the text moves on its own, a minute at a time.
const now = ref(Math.floor(Date.now() / 1000));
let tick = null;
onMounted(() => {
	tick = setInterval(() => (now.value = Math.floor(Date.now() / 1000)), 60_000);
});
onBeforeUnmount(() => clearInterval(tick));

const text = (alert) => alertText(alert, now.value);

const stop = (alert) => $rounds.stop(alert).catch(() => undefined);

const itsMe = async (alert) => {
	const ok = $swal
		? (
				await $swal.fire({
					icon: 'warning',
					title: 'Is this recovery yours?',
					text: 'Only if you started it yourself, from a new device. If you hide this and it is not you, someone else gets into your account.',
					showCancelButton: true,
					confirmButtonText: 'Yes, it is me',
					cancelButtonText: 'Back',
				})
			).isConfirmed
		: true;
	if (ok) $rounds.acknowledge(alert);
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
