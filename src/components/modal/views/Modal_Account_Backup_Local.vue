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
import { userPQStore } from '@/store/userPQ.store';


import { inject, ref, watch, computed } from 'vue';
import errorMessage from '@/utils/errorMessage';

const $enigma = inject('$enigma');
const $userPQ = userPQStore();
const $swal = inject('$swal');
const $mitt = inject('$mitt');

const protect = ref(true);
const showPassword = ref(true);
const password = ref('');
const dirty = ref(false);
const processing = ref(false);

watch(
	() => protect.value,
	(val) => {
		if (!val) {
			password.value = '';
			showPassword.value = true;
			dirty.value = false;
		}
	},
);

watch(
	() => password.value,
	(val) => {
		if (val) {
			password.value = password.value.replaceAll(' ', '');
			if (val.length > 3) dirty.value = true;
		}
	},
);

const backup = async () => {
	dirty.value = true;
	if (passwordErrors.value.length) return;
	
	processing.value = true;
	
	await new Promise(r => setTimeout(r, 100));

	try {
		const backup = await $userPQ.exportBackup();
		if (!backup) {
			$swal.fire({
				icon: 'error',
				title: 'Backup error',
				text: 'Unable to export backup data. Make sure you are logged in.',
				timer: 5000,
			});
			return;
		}

		const jsonString = JSON.stringify(backup, null, 2);

		let backupString;
		if (password.value) {
			const base64PlainData = btoa(unescape(encodeURIComponent(jsonString)));
			const base64Password = btoa(password.value);
			backupString = $enigma.encryptData(base64PlainData, base64Password);
		} else {
			backupString = jsonString;
		}

		const blob = new Blob([backupString], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = generateBackupName($userPQ.currentUser?.name || 'account');
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		showPassword.value = true;
		password.value = '';
		dirty.value = false;
		
		$mitt.emit('modal::close');
	} catch (e) {
		console.error(e);
		$swal.fire({
			icon: 'error',
			title: 'Backup error',
			text: errorMessage(e),
			timer: 8000,
		});
	} finally {
		processing.value = false;
	}
};

function generateBackupName(rawName) {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	const datePart = `${yyyy}_${mm}_${dd}`;
	const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
	return `backup_${datePart}_${safeName}${password.value ? '_encrypted' : '_raw'}.bukitup`;
}

const passwordErrors = computed(() => {
	const errors = [];
	if (!protect.value) return errors;
	if (!password.value) return ['Password is required'];

	if (password.value.length < 10) errors.push('Must be at least 10 characters long.');
	if (!/[A-Z]/.test(password.value)) errors.push('Must contain an uppercase letter (A-Z).');
	if (!/[a-z]/.test(password.value)) errors.push('Must contain a lowercase letter (a-z).');
	if (!/\d/.test(password.value)) errors.push('Must contain a digit (0-9).');
	if (!/[!@#$%^&*(),.?":{}|<>]/.test(password.value)) errors.push('Must contain a special character (e.g. !@#$%^&*).');

	return errors;
});
</script>