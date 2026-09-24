<template>
	<div>
		<div class="_divider mb-2">
			Provide shares
			<InfoTooltip class="align-self-center ms-2" :content="'Paste as many shares as the backup\'s threshold, in any order. Each is one bks2 line.'" />
		</div>

		<div class="_input_block">
			<div class="mb-2" v-for="(share, idx) in shares" :key="idx">
				<div class="d-flex justify-content-between align-items-center">
					<div class="fw-bold mb-1">Share # {{ idx + 1 }}</div>
					<i class="_icon_times bg-dark _pointer" @click="shares.splice(idx, 1)" v-if="shares.length > 1"></i>
				</div>
				<textarea class="form-control" rows="3" placeholder="bks2.…" v-model="shares[idx]"></textarea>
			</div>
		</div>

		<div class="row justify-content-center gx-2 mt-3">
			<div class="col-lg-12 col-xl-10 mb-2">
				<button type="button" class="btn btn-outline-dark w-100" @click="shares.push('')">Add share</button>
			</div>
			<div class="col-lg-12 col-xl-10 mb-2">
				<button type="button" class="btn btn-dark w-100" @click="recover()" :disabled="!shares.some((v) => v?.trim()) || processing">
					<span v-if="processing" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
					Restore
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped></style>

<script setup>
import { ref, inject } from 'vue';
import { BackupFormatError } from '@/lib/backupCrypto';
import { restoreFromShares } from '@/lib/wrapKeyShares';
import { VaultLookupError } from '@/lib/recovery/vault';
import { useRestoreAccount } from '@/composables/useRestoreAccount';

const $swal = inject('$swal');
const { restore } = useRestoreAccount();

const shares = ref(['']);
const processing = ref(false);

// Each failure names a different next move: re-copy a share, look for the
// backup elsewhere, or check the shares are from the same backup.
const titleFor = (error) => {
	if (error instanceof BackupFormatError) return 'Shares do not combine';
	if (error instanceof VaultLookupError) return error.reason === 'absent' ? 'No backup found' : 'Wrong key';
	return 'Restore error';
};

const recover = async () => {
	processing.value = true;
	try {
		if (await restore(await restoreFromShares(shares.value))) {
			$swal.fire({ icon: 'success', title: 'Account restored', timer: 5000 });
		}
	} catch (error) {
		console.error(error);
		$swal.fire({ icon: 'error', title: titleFor(error), text: error.message, timer: 15000 });
	} finally {
		processing.value = false;
	}
};
</script>
