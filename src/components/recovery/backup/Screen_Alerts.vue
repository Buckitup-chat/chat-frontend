<template>
	<!-- 7.3: skipping asks once more -->
	<template v-if="confirmSkip">
		<ScreenHeader title="Continue without alerts?" />
		<div class="cb-muted">Without alerts you may not learn about an attempt in time to stop it.</div>
		<div class="cb-actions">
			<button class="btn btn-dark w-100" data-test="back-to-alerts" @click="confirmSkip = false">Set up alerts</button>
			<button class="btn btn-outline-danger w-100" data-test="skip-anyway" @click="skip">Skip anyway</button>
		</div>
	</template>

	<!-- 7.1: the channels -->
	<template v-else>
		<ScreenHeader title="Where should we warn you?" :step="setup ? 2 : 0" step-label="Alerts" back />
		<div class="cb-muted">If someone else starts a recovery, you have {{ delayWords }} to stop it from any of your devices. An alert tells you it started.</div>

		<div class="cb-tile">
			<div class="cb-tile-head">
				<span class="cb-check on">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>
				</span>
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="cb-tile-title">In the app</span>
					<span class="cb-muted">always on</span>
				</div>
			</div>
		</div>

		<div class="cb-tile pickable" :class="{ picked: a.telegram }" data-test="tile-telegram" @click="!a.telegram && nav.go('telegram')">
			<div class="cb-tile-head">
				<span class="cb-check" :class="{ on: a.telegram }">
					<svg v-if="a.telegram" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>
				</span>
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="cb-tile-title">Telegram</span>
					<span class="cb-muted">a message from our bot</span>
				</div>
				<span v-if="a.telegram" class="cb-status-ok">connected</span>
				<span v-else class="cb-small">Connect</span>
			</div>
		</div>

		<div class="cb-tile pickable" :class="{ picked: a.webhook || webhookOpen }" data-test="tile-webhook" @click="!a.webhook && (webhookOpen = !webhookOpen)">
			<div class="cb-tile-head">
				<span class="cb-check" :class="{ on: a.webhook }">
					<svg v-if="a.webhook" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>
				</span>
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="cb-tile-title">Webhook</span>
					<span class="cb-muted">for email or SMS gateways</span>
				</div>
				<span v-if="a.webhook" class="cb-status-ok">connected</span>
			</div>
			<div v-if="webhookSecret" class="cb-tile-body" @click.stop>
				<span class="cb-small">The receiving end checks each alert with this secret. It is shown only once: keep it now.</span>
				<CopyField :value="webhookSecret" wrap />
			</div>
			<div v-else-if="webhookOpen && !a.webhook" class="cb-tile-body" @click.stop>
				<div class="d-flex gap-2">
					<input v-model="webhookUrl" type="url" class="form-control" placeholder="https://" aria-label="Webhook address" :disabled="connecting" />
					<button class="btn btn-outline-dark" :disabled="!webhookOk || connecting" @click="connectWebhook">
						<span v-if="connecting" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
						<template v-else>Connect</template>
					</button>
				</div>
				<span v-if="webhookError" class="cb-field-error">{{ webhookError }}</span>
			</div>
		</div>

		<div v-if="saveError" class="cb-error">{{ saveError }}</div>
		<div class="cb-actions">
			<button v-if="setup" class="btn btn-dark w-100" :disabled="!draft.alertsConnected.value" data-test="next" @click="next">Next: review</button>
			<button v-else class="btn btn-dark w-100" :disabled="!draft.alertsConnected.value || saving" data-test="save" @click="saveAlerts">Save</button>
			<button v-if="setup" class="btn btn-link text-secondary w-100" data-test="skip" @click="confirmSkip = true">Skip alerts</button>
		</div>
	</template>
</template>

<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { durationText } from '@/lib/recovery/backupPlan';
import ScreenHeader from './ScreenHeader.vue';
import CopyField from './CopyField.vue';
import { DRAFT, NAV } from './backupFlow';

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();

/** Part of the setup, or adding alerts to a finished backup that has none. */
const setup = store.run?.step !== 'done';
const a = draft.state.alerts;
const delaySec = computed(() => (setup ? draft.settings.value.delaySec : store.run?.settings?.delaySec));
const delayWords = computed(() => (delaySec.value ? durationText(delaySec.value) : 'the waiting period'));

// Channels already set up for this account count: the server lists kinds only.
onMounted(async () => {
	try {
		const subs = await store.subscriptions();
		if (subs.some((s) => s.kind === 'telegram')) a.telegram = true;
		if (subs.some((s) => s.kind === 'webhook')) a.webhook = true;
	} catch (e) {
		console.warn('[recovery] alert channels could not be read:', e);
	}
});

const webhookOpen = ref(false);
const webhookUrl = ref('');
const webhookOk = computed(() => /^https:\/\/[^\s/]+\.[^\s]+$/i.test(webhookUrl.value.trim()));
const webhookSecret = ref(null);
const webhookError = ref(null);
const connecting = ref(false);
const connectWebhook = async () => {
	connecting.value = true;
	webhookError.value = null;
	try {
		const { secret } = await store.addWebhook(webhookUrl.value.trim());
		webhookSecret.value = secret;
		a.webhook = true;
	} catch (e) {
		webhookError.value = e?.message ?? String(e);
	} finally {
		connecting.value = false;
	}
};

const confirmSkip = ref(false);
const next = () => {
	a.skipped = false;
	nav.go('review');
};
const skip = () => {
	a.skipped = true;
	confirmSkip.value = false;
	nav.go('review');
};

const saving = ref(false);
const saveError = ref(null);
const saveAlerts = async () => {
	saving.value = true;
	saveError.value = null;
	try {
		await store.setAlerts({ channels: [...draft.alertChannels.value], skipped: false });
		nav.close();
	} catch (e) {
		saveError.value = e?.message ?? String(e);
	} finally {
		saving.value = false;
	}
};
</script>
