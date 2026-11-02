<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="ui-title">Notifications</div>
		</template>
		<template #content>
			<div class="_page">
				<section class="ui-card _card">
					<div class="_head">
						<i class="_icon_notifications"></i>
						<h2>Recovery alerts</h2>
						<span v-if="alerts" class="ui-badge" :class="alerts.on ? '_success' : '_warning'" data-test="alerts-state">
							{{ alerts.on ? 'On' : 'Off' }}
						</span>
					</div>
					<p class="ui-small ui-secondary">
						Alerts are about your account's recovery. Your guardians each keep a piece of your backup, and enough
						pieces together can bring the account back. If anyone starts such a recovery,
						<a :href="botUrl" target="_blank" rel="noopener noreferrer">@{{ ALERTS_BOT }}</a> on Telegram tells you,
						so you can stop it in time if it is not you.
					</p>

					<template v-if="!store.deployment">
						<div class="ui-small ui-muted">Not available in this version of the app.</div>
					</template>
					<div v-else-if="!store.loaded" class="ui-skeleton _skel"></div>
					<template v-else-if="alerts">
						<div class="ui-small" data-test="alerts-channels">
							{{ alerts.on ? `Alerts go to: ${alerts.channels}.` : 'Only the app alerts you, and it can be lost with the phone.' }}
						</div>
						<button type="button" class="ui-btn _block" :class="{ _outline: alerts.on }" @click="openAlerts()">
							{{ alerts.on ? 'Change alerts' : 'Set up alerts' }}
						</button>
					</template>
					<template v-else>
						<div class="ui-notice" data-test="alerts-need-backup">
							Alerts come with a guardian backup: without one there is nothing to recover from guardians' pieces.
						</div>
						<router-link :to="{ name: 'account_backups' }" class="ui-btn _outline _block">Open Backup Center</router-link>
					</template>
				</section>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._page {
	width: 100%;
	max-width: 30rem;

	@include media-breakpoint-up(md) {
		max-width: 36rem;
	}
}

._card {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);

	@include media-breakpoint-up(md) {
		padding: var(--space-5);
	}

	p { margin: 0; }
	p a { color: var(--color-accent); }
}

._head {
	display: flex;
	align-items: center;
	gap: var(--space-2);

	i { width: 22px; height: 22px; background-color: var(--color-text); }

	h2 {
		flex: 1;
		margin: 0;
		font-size: var(--text-lg);
		line-height: var(--leading-lg);
		font-weight: var(--weight-medium);
	}
}

._skel { height: 44px; }
</style>

<script setup>
import { computed, inject, onMounted } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { alertsText, hasOutsideAlerts, isLiveBackup } from '@/components/recovery/backup/backupFlow';
import { ALERTS_BOT } from '@/config/recovery';

const $userPQ = userPQStore();
const $modal = inject('$modal');
const store = useRecoveryBackupStore();

const botUrl = `https://t.me/${ALERTS_BOT}`;

onMounted(() => {
	if (store.deployment && !store.loaded) store.load().catch((e) => console.warn('[notifications] the backup could not be read:', e));
});

/** The live backup's alerts, or null with no backup to be alerted about. */
const alerts = computed(() => {
	const run = store.run;
	if (!isLiveBackup(run)) return null;
	return { on: hasOutsideAlerts(run.alerts), channels: alertsText(run.alerts?.channels) };
});

const openAlerts = () => $modal.value.open({ id: 'community_backup', start: 'alerts' });
</script>
