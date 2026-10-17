<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="fw-bold fs-5 py-1">Security & Recovery</div>
		</template>

		<template #content>
			<div class="_full_width_block">
				<div class="text-secondary mb-4 text-center">
					Choose a backup or recovery method for your account.
				</div>

				<!-- Community backup: guardians and nodes. No Restore here: recovery
				     starts from the login page, where the person who needs it is. -->
				<CommunityBackupCard />

				<!-- The other side of it: pieces of contacts' backups this account keeps. -->
				<SharesIKeepCard />

				<!-- Local File -->
				<div class="card mb-3 shadow-sm border-0">
					<div class="card-body">
						<div class="d-flex align-items-center mb-2">
							<i class="_icon_backups bg-dark fs-3 me-3" style="width: 2rem; height: 2rem;"></i>
							<h5 class="card-title mb-0 fw-bold">Local File</h5>
						</div>
						<p class="card-text text-secondary mb-3">
							Save an encrypted backup file to your device. Keeping it safe —
							and remembering the password — is entirely on you: nobody can
							recover this file for you.
						</p>
						<div class="d-flex gap-2">
							<button class="btn btn-outline-dark flex-fill" @click="openModal('account_backup_local')">
								+ Create Backup
							</button>
							<button class="btn btn-dark flex-fill" @click="openModal('account_restore_local')">
								<i class="_icon_reload icon-inline"></i>Restore
							</button>
						</div>
					</div>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._full_width_block {
	width: 100%;
}

.card {
	background-color: #f8f9fa;
	border-radius: 12px;
}
</style>

<script setup>
import { userPQStore } from '@/store/userPQ.store';


import { inject } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import CommunityBackupCard from '@/components/recovery/backup/CommunityBackupCard.vue';
import SharesIKeepCard from '@/components/recovery/SharesIKeepCard.vue';

const $userPQ = userPQStore();
const $modal = inject('$modal');

const openModal = (modalId) => {
	$modal.value.open({ id: modalId });
};
</script>