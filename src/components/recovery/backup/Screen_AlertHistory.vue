<template>
	<ScreenHeader title="Alert history" back />

	<div v-if="loading" class="cb-small"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Reading the alert history…</div>
	<div v-else-if="error" class="cb-error" data-test="history-error">
		<span>Could not read the alert history: {{ error }}</span>
		<div><button class="btn btn-sm btn-outline-dark bg-white" @click="load">Try again</button></div>
	</div>
	<div v-else-if="!items.length" class="cb-muted" data-test="history-empty">No alert has been sent yet. When someone starts a recovery of your backup, it shows here.</div>
	<div v-else class="cb-group">
		<div v-for="(a, i) in items" :key="i" class="cb-setting" data-test="history-row">
			<span class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">{{ TYPE_TEXT[a.type] ?? 'Alert' }}</span>
				<span class="cb-small">{{ [alertsText([a.kind], { title: true }), a.createdAt ? dateText(Date.parse(a.createdAt) / 1000, { time: true }) : null].filter(Boolean).join(' · ') }}</span>
			</span>
			<span :class="a.emitted ? 'cb-status-ok' : 'cb-status-warn'">{{ a.emitted ? 'sent' : 'not sent yet' }}</span>
		</div>
	</div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import { alertsText, dateText } from './backupFlow';

// The alerts the notification server sent about the owner's backups (plan
// § 7.4, Alerts outside the app), newest first. The server keeps what
// happened, never where it was sent.
const TYPE_TEXT = { RECOVERY_STARTED: 'A recovery was started', QUORUM_REACHED: 'Enough guardians approved a recovery' };

const store = useRecoveryBackupStore();
const items = ref([]);
const loading = ref(false);
const error = ref(null);

const load = async () => {
	loading.value = true;
	error.value = null;
	try {
		const out = await store.history();
		items.value = Array.isArray(out) ? out : [];
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		loading.value = false;
	}
};
onMounted(load);
</script>
