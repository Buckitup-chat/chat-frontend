<template>
	<ScreenHeader title="Connect Telegram" back />

	<template v-if="!connected">
		<!-- 1: the bot is sent the address first -->
		<div class="d-flex gap-3">
			<span class="tg-num" :class="{ done: stage > 1 }">1</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold">Open @{{ ALERTS_BOT }} and send it your address</span>
				<a :href="`https://t.me/${ALERTS_BOT}`" target="_blank" rel="noopener" class="small">Open in Telegram ↗</a>
				<CopyField v-if="wallet" :value="wallet" :shown="wallet" />
				<span v-else-if="walletError" class="cb-field-error">{{ walletError }}</span>
			</div>
		</div>

		<!-- 2: its reply comes back here and is checked before anything is signed -->
		<div class="d-flex gap-3">
			<span class="tg-num" :class="{ done: stage > 2 }">2</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold">Paste the bot's reply here</span>
				<textarea v-model="reply" class="form-control form-control-sm" rows="5" aria-label="The bot's reply" :disabled="stage > 2"></textarea>
				<span v-if="replyError" class="cb-field-error" data-test="reply-error">{{ replyError }}</span>
				<div v-if="stage === 2"><button class="btn btn-sm btn-dark" :disabled="!reply.trim()" @click="sign">Continue</button></div>
			</div>
		</div>

		<!-- 3: the signed line goes back to the bot -->
		<div class="d-flex gap-3">
			<span class="tg-num">3</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold" :class="{ 'text-secondary': stage < 3 }">Send this line back to the bot</span>
				<template v-if="line">
					<CopyField :value="line" wrap />
					<span class="cb-small"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Waiting for the bot… This screen updates by itself when the bot gets your line.</span>
				</template>
			</div>
		</div>
	</template>

	<div v-else class="cb-ok" data-test="connected">Connected. Alerts will come from @{{ ALERTS_BOT }}.</div>

	<div class="cb-actions">
		<button class="btn btn-dark w-100" :disabled="!connected" @click="nav.back()">Done</button>
	</div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { ALERTS_BOT } from '@/config/recovery';
import ScreenHeader from './ScreenHeader.vue';
import CopyField from './CopyField.vue';
import { DRAFT, NAV } from './backupFlow';

const POLL_MS = 4000;

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();

const wallet = ref(null);
const walletError = ref(null);
const reply = ref('');
const replyError = ref(null);
const line = ref(null);
const connected = ref(false);
const stage = computed(() => (line.value ? 3 : 2));

onMounted(async () => {
	try {
		wallet.value = await store.walletForBot();
	} catch (e) {
		walletError.value = e?.message ?? String(e);
	}
});

let timer = null;
const poll = async () => {
	try {
		const subs = await store.subscriptions();
		if (subs.some((s) => s.kind === 'telegram')) {
			connected.value = true;
			draft.state.alerts.telegram = true;
			clearInterval(timer);
		}
	} catch (e) {
		console.warn('[recovery] alert channels could not be read:', e);
	}
};
onBeforeUnmount(() => clearInterval(timer));

const sign = async () => {
	replyError.value = null;
	try {
		line.value = await store.telegramLine(reply.value);
		timer = setInterval(poll, POLL_MS);
	} catch (e) {
		replyError.value = e?.message ?? String(e);
	}
};
</script>

<style lang="scss" scoped>
.tg-num {
	width: 22px;
	height: 22px;
	flex-shrink: 0;
	border-radius: 50%;
	background: #241824;
	color: #fff;
	font-size: 12px;
	font-weight: 600;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	&.done {
		background: #2ebe21;
	}
}
</style>
