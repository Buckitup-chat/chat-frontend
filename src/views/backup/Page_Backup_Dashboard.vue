<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="ui-title">Backup Center</div>
		</template>

		<template #content>
			<div class="_page">
				<!-- Shown once the guardians answered: otherwise it would jump from "not protected" to "protected". -->
				<div v-if="status" class="_status" :class="`_${status.tone}`" data-test="backup-status">
					<span class="_status_icon"><i :class="status.tone === 'success' ? '_icon_verified' : '_icon_warning'"></i></span>
					<div>
						<div class="_status_title">{{ status.title }}</div>
						<div class="ui-small">{{ status.text }}</div>
					</div>
				</div>
				<div v-else class="ui-skeleton _status_skel"></div>

				<div class="_cards">
					<section class="ui-card _file">
						<div class="_file_head">
							<i class="_icon_backup_file"></i>
							<h2>Backup file</h2>
							<span v-if="fileAt" class="ui-badge _success" data-test="file-saved">saved {{ shortDay(fileAt) }}</span>
						</div>
						<p class="ui-small ui-secondary">
							An encrypted copy of your account. You keep the file and its password: nobody can recover them for you.
						</p>
						<button type="button" class="ui-btn _block" :class="{ _outline: fileAt }" @click="openModal('account_backup_local')">
							{{ fileAt ? 'Download again' : 'Download backup file' }}
						</button>
					</section>

					<!-- Community backup: guardians and nodes. -->
					<CommunityBackupCard />
				</div>

				<!-- The other side of it: pieces of contacts' backups this account keeps. -->
				<SharesIKeepCard />

				<div class="ui-card _restore">
					<UiRow title="Restore an account" sub="From a backup file." icon="restore" bare button
						@select="openModal('account_restore_local')" />
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._page {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	width: 100%;
	max-width: 30rem;

	@include media-breakpoint-up(md) {
		gap: var(--space-5);
		max-width: 52rem;
	}
}

._status {
	display: flex;
	align-items: center;
	gap: var(--space-4);
	padding: var(--space-4);
	border-radius: var(--radius-card);

	&._success { background: var(--color-success-bg); color: var(--color-success); }
	&._danger { background: var(--color-danger-bg); color: var(--color-danger); }

	@include media-breakpoint-up(md) {
		padding: var(--space-5);
	}
}

._status_icon {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 40px;
	height: 40px;
	border-radius: 50%;
	background: var(--color-bg);

	i { width: 22px; height: 22px; background-color: currentColor; }
}

._status_title {
	font-size: var(--text-lg);
	line-height: var(--leading-lg);
	font-weight: var(--weight-medium);

	@include media-breakpoint-up(md) {
		font-size: var(--text-xl);
		line-height: var(--leading-xl);
	}
}

._status_skel { height: 76px; border-radius: var(--radius-card); }

._cards {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);

	@include media-breakpoint-up(md) {
		display: grid;
		grid-template-columns: 2fr 3fr;
		align-items: start;
		gap: var(--space-5);
	}
}

._file {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);

	@include media-breakpoint-up(md) {
		padding: var(--space-4) var(--space-5);
	}

	p { margin: 0; }
}

._file_head {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
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

._restore {
	padding: 0 var(--space-4);
}
</style>

<script setup>
import { computed, inject } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import UiRow from '@/components/ui/UiRow.vue';
import CommunityBackupCard from '@/components/recovery/backup/CommunityBackupCard.vue';
import SharesIKeepCard from '@/components/recovery/SharesIKeepCard.vue';
import { healthView, isLiveBackup } from '@/components/recovery/backup/backupFlow';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { backupFileSavedAt } from '@/lib/backupFileRecord';
import { shortDay } from '@/lib/shortDate';

const $userPQ = userPQStore();
const $modal = inject('$modal');
const store = useRecoveryBackupStore();

const openModal = (modalId) => {
	$modal.value.open({ id: modalId });
};

const fileAt = computed(() => backupFileSavedAt($userPQ.currentUserHash));

/** The guardians can bring the account back now: a live backup with at least as many stored pieces as it needs. */
const guardiansProtect = computed(() =>
	isLiveBackup(store.run) && ['spare_2', 'spare_1', 'at_threshold'].includes(healthView(store.run, store.receipts).level));

// Only guardians protect the account: a file can be lost, or its password forgotten.
const status = computed(() => {
	if (store.deployment && !store.loaded) return null;
	const file = !!fileAt.value;
	if (!guardiansProtect.value) {
		return {
			tone: 'danger',
			title: 'Account not protected',
			text: file
				? 'A backup file alone can be lost, or its password forgotten. Add guardians, so you can get back in without it.'
				: 'If you lose this device, you lose the account. Add guardians, so you can get back in.',
		};
	}
	return {
		tone: 'success',
		title: 'Account protected',
		text: file ? 'You can get back in with your guardians or with your backup file.' : 'You can get back in with your guardians.',
	};
});
</script>
