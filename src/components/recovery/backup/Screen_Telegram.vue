<template>
	<ScreenHeader title="Connect Telegram" back />

	<template v-if="!connected">
		<!-- 1: the bot is sent the address first -->
		<div class="d-flex gap-3">
			<span class="tg-num done">1</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold">Open @{{ ALERTS_BOT }} and send it your address</span>
				<a :href="`https://t.me/${ALERTS_BOT}`" target="_blank" rel="noopener" class="small">Open in Telegram ↗</a>
				<CopyField v-if="wallet" :value="wallet" />
				<span v-else-if="walletError" class="cb-field-error">{{ walletError }}</span>
			</div>
		</div>

		<!-- 2: its reply comes back here and is checked before anything is signed -->
		<div class="d-flex gap-3">
			<span class="tg-num" :class="{ done: !!line }">2</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold">Paste the bot's reply here</span>
				<textarea v-model="reply" class="form-control form-control-sm" rows="5" aria-label="The bot's reply" :disabled="!!line"></textarea>
				<span v-if="replyError" class="cb-field-error" data-test="reply-error">{{ replyError }}</span>
				<div v-if="!line"><button class="btn btn-sm btn-dark" :disabled="!reply.trim()" @click="sign">Continue</button></div>
			</div>
		</div>

		<!-- 3: the signed line goes back to the bot -->
		<div class="d-flex gap-3">
			<span class="tg-num">3</span>
			<div class="flex-grow-1 d-flex flex-column gap-2">
				<span class="fw-semibold" :class="{ 'text-secondary': !line }">Send this line back to the bot</span>
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
import { inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { ALERTS_BOT } from '@/config/recovery';
import errorMessage from '@/utils/errorMessage';
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

onMounted(async () => {
	try {
		wallet.value = await store.walletForBot();
	} catch (e) {
		walletError.value = errorMessage(e);
	}
});

// Each poll is asked after the last one answered, so requests never overlap.
let timer = null;
let left = false;
const poll = async () => {
	try {
		const subs = await store.subscriptions({ refresh: true });
		if (subs.some((s) => s.kind === 'telegram')) {
			connected.value = true;
			draft.state.alerts.telegram = true;
			return;
		}
	} catch (e) {
		console.warn('[recovery] alert channels could not be read:', e);
	}
	if (!left) timer = setTimeout(poll, POLL_MS);
};
onBeforeUnmount(() => {
	left = true;
	clearTimeout(timer);
});

const sign = async () => {
	replyError.value = null;
	try {
		line.value = await store.telegramLine(reply.value);
		clearTimeout(timer);
		timer = setTimeout(poll, POLL_MS);
	} catch (e) {
		replyError.value = errorMessage(e);
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
