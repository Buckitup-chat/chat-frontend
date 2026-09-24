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

				<!-- Blockchain -->
				<div class="card mb-3 shadow-sm border-0" style="opacity: 0.7;">
					<div class="card-body">
						<div class="d-flex align-items-center mb-2">
							<i class="_icon_network bg-dark fs-3 me-3" style="width: 2rem; height: 2rem;"></i>
							<h5 class="card-title mb-0 fw-bold">Blockchain Recovery</h5>
							<span class="badge bg-secondary ms-2 rounded-pill">Coming Soon</span>
						</div>
						<p class="card-text text-secondary mb-3">
							Link a crypto wallet for on-chain authentication.
						</p>
						<div class="d-flex gap-2">
							<button class="btn btn-outline-dark flex-fill" disabled>
								+ Create Backup
							</button>
							<button class="btn btn-dark flex-fill" disabled>
								<i class="bi bi-arrow-clockwise"></i> Restore
							</button>
						</div>
					</div>
				</div>

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
								<i class="bi bi-arrow-clockwise"></i> Restore
							</button>
						</div>
					</div>
				</div>

				<!-- Splitting the key by hand is the sandbox the community scheme is
				     being built from, not a way to back up an account: the shares are
				     moved around by copy-paste. The card asks whether its destinations
				     exist rather than re-reading the build flag. -->
				<div v-if="sharesAvailable" class="card mb-3 shadow-sm border-0">
					<div class="card-body">
						<div class="d-flex align-items-center mb-2">
							<i class="_icon_shares bg-dark fs-3 me-3" style="width: 2rem; height: 2rem;"></i>
							<h5 class="card-title mb-0 fw-bold">Distributed Shares (Shamir)</h5>
						</div>
						<p class="card-text text-secondary mb-3">
							Seal the account on the server and split the key to it among trusted contacts or devices.
						</p>
						<div class="d-flex gap-2">
							<button class="btn btn-outline-dark flex-fill" @click="openModal('account_backup_shamir_create')">
								+ Create Backup
							</button>
							<button class="btn btn-dark flex-fill" @click="openModal('account_restore_shares')">
								<i class="bi bi-arrow-clockwise"></i> Restore
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

const $userPQ = userPQStore();
const $modal = inject('$modal');

import { isModalAvailable } from '@/components/modal/registry';

const sharesAvailable = isModalAvailable('account_backup_shamir_create');

const openModal = (modalId) => {
	$modal.value.open({ id: modalId });
};
</script>