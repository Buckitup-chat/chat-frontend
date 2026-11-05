<template>
	<div v-if="store.reminderDue" class="passkey-reminder" role="status" data-test="passkey-recovery-reminder">
		<span class="passkey-reminder-text">
			This account lives only in this browser, which may clear its data, and this device has no backup of it.
			Your passkey can restore it.
		</span>
		<button type="button" class="passkey-reminder-action" data-test="passkey-reminder-open" @click="open">Set it up</button>
		<button type="button" class="passkey-reminder-action" data-test="passkey-reminder-dismiss" @click="store.dismissReminder()">Not now</button>
	</div>
</template>

<script setup lang="ts">
import { inject, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { usePasskeyRecoveryStore } from '@/store/passkeyRecovery.store';

type Router = { push: (to: { name: string }) => unknown };

const $userPQ = userPQStore();
const $router = inject<Router>('$router')!;
const $route = inject<{ name?: unknown } | null>('$route', null);
const store = usePasskeyRecoveryStore();

watch(() => $userPQ.currentUserHash, (account) => {
	if (account) store.checkReminder().catch(() => {});
}, { immediate: true });

const open = () => {
	store.hideReminder();
	$router.push({ name: 'account_backups' });
};

watch(() => $route?.name, (to, from) => {
	if (from === 'account_backups' && to !== 'account_backups' && $userPQ.currentUserHash) store.checkReminder().catch(() => {});
});
</script>

<style lang="scss" scoped>
.passkey-reminder {
	position: sticky;
	top: 0;
	z-index: 1400;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 10px;
	background: #e8f1fb;
	border-bottom: 1px solid #9bbbe0;
}

.passkey-reminder-text {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	color: #1f4a7a;
}

.passkey-reminder-action {
	border: none;
	background: none;
	color: #1f4a7a;
	font-size: 12px;
	font-weight: 600;
	padding: 2px 6px;
	cursor: pointer;
	white-space: nowrap;
}
</style>
