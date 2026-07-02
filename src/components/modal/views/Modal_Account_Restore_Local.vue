<template>
	<div>
		<div class="_divider mt-3">
			Upload your backup file
			<InfoTooltip class="align-self-center ms-2" :content="'Upload your backup file info'" />
		</div>

		<div class="row justify-content-center gx-2 mt-3">
			<div class="col-md-20">
				<button type="button" class="btn btn-dark w-100" @click="fileInput.click()">Upload</button>
			</div>
			<input type="file" ref="fileInput" accept=".bukitup" style="height: 0px; width: 0px" @change="handleRestore" :key="fileInputKey" />
		</div>

		<template v-if="fileString && requestDecrypt">
			<div class="_divider mt-3">
				Decrypt backup
				<InfoTooltip class="align-self-center ms-2" :content="'Decrypt backup info'" />
			</div>
			<div class="_input_block w-100 px-3 mt-2 mb-2">
				<label for="password" class="form-label d-flex align-items-center">
					Password
					<InfoTooltip class="align-self-center ms-2" :content="'Password info'" />
				</label>

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
						/>
					</form>

					<button class="btn btn-dark ms-2 d-flex align-items-center" @click="showPassword = !showPassword">
						<i class="bg-white" :class="[showPassword ? '_icon_eye_cross' : '_icon_eye']"> </i>
					</button>
				</div>
			</div>

			<div class="row justify-content-center gx-2 mt-3">
				<div class="col-md-20">
					<button class="btn btn-dark w-100" :disabled="!password || processing" @click="decrypt()">
						<span v-if="processing" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
						Decrypt and restore
					</button>
				</div>
			</div>
		</template>
	</div>
</template>

<style lang="scss" scoped></style>

<script setup>
import { userPQStore } from '@/store/userPQ.store';


import { ref, inject } from 'vue';
import errorMessage from '@/utils/errorMessage';

const $swal = inject('$swal');
const $userPQ = userPQStore();
const $mitt = inject('$mitt');
const $enigma = inject('$enigma');
const $router = inject('$router');
const $swalModal = inject('$swalModal');

const fileString = ref();
const requestDecrypt = ref();
const password = ref();
const showPassword = ref();
const processing = ref(false);

const fileInput = ref();
const fileInputKey = ref(0);

const handleRestore = async (event) => {
	fileString.value = null;
	requestDecrypt.value = null;

	const file = Array.from(event.target.files)[0];
	if (!file) return;

	const reader = new FileReader();

	reader.onload = async (e) => {
		fileString.value = e.target.result;
		if (!fileString.value) return;

		let data;
		try {
			data = JSON.parse(fileString.value);
		} catch (_) {
			// not JSON — likely encrypted
		}

		if (!data) {
			requestDecrypt.value = true;
		} else {
			await applyBackup(data);
		}
	};

	reader.onerror = () => {
		$swal.fire({
			icon: 'error',
			title: 'File read error',
			text: 'Could not read the selected file.',
			timer: 5000,
		});
	};

	reader.readAsText(file);
};

const decrypt = async () => {
	try {
		processing.value = true;
		await new Promise(r => setTimeout(r, 100));
		const base64Password = btoa(password.value);
		const decryptedBase64 = $enigma.decryptData(fileString.value, base64Password);
		const jsonString = decodeURIComponent(escape(atob(decryptedBase64)));
		const data = JSON.parse(jsonString);
		await applyBackup(data);
	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Unable to decrypt',
			text: 'Check if password is correct and the backup file is valid.',
			footer: errorMessage(error),
			timer: 15000,
		});
	} finally {
		processing.value = false;
	}
};

const applyBackup = async (data) => {
	try {
		if (!data.identity || !data.keys || !data.identity.user_hash) {
			$swal.fire({
				icon: 'error',
				title: 'Invalid backup format',
				text: 'This backup file is not compatible with the current version.',
				timer: 10000,
			});
			fileInputKey.value++;
			return;
		}

		const existing = $userPQ.myLocalUsers?.find(u => u.user_hash === data.identity.user_hash);
		if (existing) {
			const confirmed = await $swalModal.value.open({
				id: 'confirm',
				title: 'Account restore',
				content: `Account <strong>${data.identity.name}</strong> already exists. Replace it?`,
			});
			if (!confirmed) {
				fileInput.value = null;
				fileInputKey.value++;
				return;
			}
		}

		await $userPQ.importBackup({ identity: data.identity, keys: data.keys });

		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
	} catch (error) {
		console.error('applyBackup error:', error);
		$swal.fire({
			icon: 'error',
			title: 'Restore error',
			text: errorMessage(error),
			timer: 15000,
		});
	}
};
</script>
