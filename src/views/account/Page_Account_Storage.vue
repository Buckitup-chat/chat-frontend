<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="fw-bold fs-5 py-1">Storage on this device</div>
		</template>
		<template #content>
			<div class="_full_width_block">
				<div class="fw-bold text-center mb-4" data-test="storage-line">{{ line }}</div>

				<template v-if="probe">
					<div class="fw-bold mb-2">Details</div>
					<table class="table table-sm small mb-3" data-test="probe-table">
						<tbody>
							<tr v-for="[label, value] in rows" :key="label">
								<td class="text-secondary">{{ label }}</td>
								<td class="text-break">{{ value }}</td>
							</tr>
						</tbody>
					</table>
					<div class="d-flex gap-2">
						<button class="btn btn-outline-dark flex-fill" :disabled="requesting" @click="request" data-test="request">
							<span v-if="requesting" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
							Request persistence
						</button>
						<button class="btn btn-dark flex-fill" @click="copy" data-test="copy">Copy</button>
					</div>
				</template>
				<KeptFilesManager class="mt-4" />
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

._full_width_block {
	max-width: 30rem;
	width: 100%;
}
</style>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { storeToRefs } from 'pinia';
import { useStorageStatusStore } from '@/store/storageStatus.store';
import { probeRows, probeText, storageStatusLine } from '@/lib/storageStatus';
import copyToClipboard from '@/utils/copyToClipboard';

import FullContentBlock from '@/components/FullContentBlock.vue';
import KeptFilesManager from '@/components/storage/KeptFilesManager.vue';

const $userPQ = userPQStore();
const storage = useStorageStatusStore();
const { probe, lastRequest, communityBackup } = storeToRefs(storage);

const line = computed(() => (probe.value ? storageStatusLine(probe.value) : 'Checking…'));

const rows = computed(() => (probe.value ? probeRows(probe.value, lastRequest.value, communityBackup.value) : []));

const requesting = ref(false);
const request = async () => {
	requesting.value = true;
	try {
		await storage.requestPersistence();
	} finally {
		requesting.value = false;
	}
};

const copy = () => copyToClipboard(probeText(rows.value));

onMounted(() => {
	storage.refresh();
});
// The backup is the signed-in account's: read again when another one signs in.
watch(() => $userPQ.currentUserHash, () => storage.refreshCommunityBackup(), { immediate: true });
</script>
