<template>
	<div>
		<div class="text-secondary mb-3 mt-3">Save backup file on your device, make sure to set secured password.</div>

		<div class="mb-3">
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
				<ul class="small text-danger mt-1" v-if="dirty && passwordErrors.length">
					<li v-for="error in passwordErrors" :key="error">{{ error }}</li>
				</ul>
			</template>
		</div>

		<button type="button" class="btn btn-dark d-flex justify-content-center align-items-center w-100" @click="backup()" :disabled="processing">
			<span v-if="processing" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
			Download Local Backup
		</button>
	</div>
</template>

<script setup>
import { useLocalBackupExport } from '@/composables/useLocalBackupExport';
import { inject } from 'vue';
import errorMessage from '@/utils/errorMessage';

const $swal = inject('$swal');
const $mitt = inject('$mitt');

const { protect, showPassword, password, dirty, processing, passwordErrors, exportToFile } =
	useLocalBackupExport();

const backup = async () => {
	try {
		if (await exportToFile()) $mitt.emit('modal::close');
	} catch (e) {
		console.error(e);
		$swal.fire({ icon: 'error', title: 'Backup error', text: errorMessage(e), timer: 8000 });
	}
};
</script>
