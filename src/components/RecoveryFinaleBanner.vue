<template>
	<!-- The end of a recovery with friends: over every screen until the backup no longer opens with what was released. -->
	<div v-if="record" class="_recovery_finale" role="status" data-test="finale">
		<template v-if="!finale.done">
			<div class="fw-semibold">Finish your recovery: renew your backup</div>
			<div class="small">
				The pieces your guardians sent back, and the node half released with them, still open your current backup. Renewing it makes a new one and makes those useless.
			</div>
			<div class="d-flex gap-2 mt-2">
				<button v-if="renewing" type="button" class="btn btn-sm btn-light" data-test="finale-progress" @click="open('progress')">Show progress</button>
				<button v-else type="button" class="btn btn-sm btn-light" data-test="finale-renew" @click="renew">{{ hasBackup ? 'Renew backup' : 'Make a new backup' }}</button>
			</div>
		</template>
		<template v-if="!record.temporaryGone">
			<div class="small mt-1" data-test="finale-temporary">
				The temporary account used for the recovery is still on this device.
				<button type="button" class="btn btn-link btn-sm p-0 align-baseline text-white" :disabled="finale.destroying" data-test="finale-destroy" @click="finale.destroyTemporary()">Remove it</button>
			</div>
			<div v-if="finale.destroyError" class="small _recovery_finale_error">{{ finale.destroyError }}</div>
		</template>
	</div>
</template>

<script setup>
// Plan § 7.5, "The finale is not optional": after a recovery with friends the
// backup is reshared — its guardians suggested, without those whose piece was
// set aside — and the temporary account is gone. Neither waits for the owner
// to think of it.
import { computed, inject, onMounted } from 'vue';
import { useRecoveryFinaleStore } from '@/store/recoveryFinale.store';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { unfinished } from '@/lib/recovery/backupRun';
import { isLiveBackup } from '@/components/recovery/backup/backupFlow';

const finale = useRecoveryFinaleStore();
const $backup = useRecoveryBackupStore();
const $modal = inject('$modal');

const record = computed(() => finale.shown);
const hasBackup = computed(() => isLiveBackup($backup.run));
const renewing = computed(() => unfinished($backup.current));

onMounted(() => {
	if ($backup.deployment && !$backup.loaded) $backup.load().catch((e) => console.warn('[recovery] backup could not be read:', e));
});

const open = (start, extra = {}) => $modal.value.open({ id: 'community_backup', start, ...extra });
// The roster's reshare (Manage → Guardians → Review), filled in from the record with the guardians to keep.
const renew = () => (hasBackup.value ? open('reshare', { keep: finale.keepGuardians }) : open('guardians'));
</script>

<style scoped>
._recovery_finale {
	background: #8e2b77;
	color: #fff;
	padding: 10px 14px;
}
._recovery_finale_error {
	color: #ffd7db;
}
</style>
