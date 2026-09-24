<template>
	<div>
		<div class="text-secondary mb-2">Safeguard access to your profile during unforeseen events, and securely back up your key to your reliable network.</div>

		<div class="_divider">
			Select your backup option
			<InfoTooltip class="align-self-center ms-2" :content="'Select your backup option info'" />
		</div>

		<div class="_input_block mt-2 d-flex _pointer p-3">
			<div class="_icon_buckitup_circle _select_icon"></div>
			<div>
				<div class="fw-bold fs-5">BuckitUp network</div>
				<div class="text-secondary">Store your key parts securely (irreversible) within the app, through your trusted network, allowing easy access offline.</div>
			</div>
		</div>

		<div class="_input_block mt-2 d-flex p-2 px-3" v-if="showLocal">
			<div class="_icon_buckup_devices _select_icon"></div>
			<div class="">
				<div class="fw-bold fs-5 _pointer" @click="exportLocally = !exportLocally">Export locally</div>

				<div class="text-secondary _pointer" @click="exportLocally = !exportLocally">Save backup file on your device, make sure to set secured password</div>

				<template v-if="exportLocally">
					<div class="mb-2 mt-2">
						<div class="form-check form-switch mb-2">
							<input class="form-check-input" type="checkbox" role="switch" id="setpassword" v-model="protect" />
							<label class="form-check-label d-flex align-items-center _pointer" for="setpassword">
								Password protect
								<InfoTooltip class="align-self-center ms-2" :content="'Password info. Provide strong password'" />
							</label>
						</div>
						<template v-if="protect">
							<div class="d-flex">
								<form autocomplete="off" class="w-100">
									<input
										:type="showPassword ? 'text' : 'password'"
										id="password"
										v-model="password"
										class="form-control"
										placeholder="password from your backup"
										autocomplete="new-password"
										readonly
										@focus="$event.target.removeAttribute('readonly')"
										:class="[dirty && (passwordErrors.length ? 'is-invalid' : 'is-valid')]"
									/>
								</form>
								<button class="btn btn-dark ms-2 d-flex align-items-center" @click="showPassword = !showPassword">
									<i class="bg-white" :class="[showPassword ? '_icon_eye_cross' : '_icon_eye']"> </i>
								</button>
							</div>
							<ul class="small" v-if="dirty && passwordErrors.length">
								<li v-for="error in passwordErrors" :key="error">{{ error }}</li>
							</ul>
						</template>
					</div>

					<button type="button" class="btn btn-dark d-flex justify-content-center align-items-center w-100" :disabled="processing" @click="backup()">Download</button>
				</template>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._select_icon {
	height: 3rem;
	min-width: 3rem;
	width: 3rem;
	margin-right: 1rem;
	margin-top: 1rem;
}
._export_locally {
	margin-left: 4rem;
	width: 100%;
}
</style>

<script setup>
import errorMessage from '@/utils/errorMessage';
import { useLocalBackupExport } from '@/composables/useLocalBackupExport';
import { inject, ref } from 'vue';

const $swal = inject('$swal');

const { protect, showPassword, password, dirty, processing, passwordErrors, exportToFile } =
	useLocalBackupExport();
const exportLocally = ref();

const { showLocal } = defineProps({ showLocal: { type: Boolean } });

const emit = defineEmits(['backup']);

const backup = async () => {
	try {
		if (await exportToFile()) emit('backup');
	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Backup error',
			text: 'Unable to write the backup file.',
			footer: errorMessage(error),
			timer: 8000,
		});
	}
};
</script>
