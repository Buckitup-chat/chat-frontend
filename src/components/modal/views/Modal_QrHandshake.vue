<template>
	<!-- Header -->
	<template v-if="!scanning">
		<div class="d-flex align-items-center justify-content-between mb-2">
			<div class="d-flex align-items-center">
				<div class="_modal_icon _icon_profile bg-black me-2"></div>
				<div>
					<div class="fs-5">Add contact</div>
				</div>
			</div>
			<div class="d-flex">
				<div class="btn _icon_times bg-dark" @click="closeModal()"></div>
			</div>
		</div>
	</template>

	<div class="_main">
		<template v-if="!scanning && !contact && !manual && !countdown">
			<!--div class="_divider my-3">Your account</div-->

			<div class="px-3 d-flex justify-content-center">
				<Account_Item :self="true" />
			</div>
		</template>

		<template v-if="!scanning && !contact && !manual && !countdown">
			<div class="_divider my-3">Scan QR code of trusted contact</div>

			<div class="d-flex _input_block py-4 mb-3">
				<img src="/img/handshake_tutorial.svg" alt="" class="w-100" />
			</div>

			<div class="text-center text-secondary mb-1 small">
				Hold the phones facing each other. Align cameras with QR codes at 10-20 cm, adjust if needed. Once successful, the qr turns green, the phone vibrates and new contact will appear for
				adding. The exact positioning may vary depending on your phone's specifications.
			</div>
		</template>

		<!-- Display QR Code for Current State -->
		<div class="text-center text-secondary fw-bold mb-1 fs-4" v-if="countdown">Turn phones to each other</div>
		<div class="text-center fw-bold fs-1" v-if="countdown">
			{{ countdown }}
		</div>

		<!-- Vue Component Engine for QRHandshakeManager -->
		<QRScannerEngine 
			ref="scannerEngineRef"
			v-if="hasCamera"
			@scanning="onScanning"
			@countdown="onCountdown"
			@completed="onHandshakeCompleted"
		/>

		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="!contact && !countdown && hasCamera">
			<div class="col-30">
				<button type="button" class="btn btn-dark btn-lg w-100" @click="toggleScanner()">
					<span v-if="!scanning">Start handshake scanning</span>
					<span v-if="scanning">Scanning... Click to stop</span>
				</button>
			</div>
		</div>
		
		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="!hasCamera && hasCamera !== undefined">
			<div class="col-30 text-center text-danger">
				Camera not detected or permission denied.
			</div>
		</div>

		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="contact">
			<div class="col-30">
				<button type="button" class="btn btn-outline-dark w-100" @click="toggleScanner()">
					{{ contact ? 'Scan again' : 'Start handshake scanning' }}
				</button>
			</div>
		</div>

		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="!scanning && !manual && !countdown">
			<div class="col-30">
				<button type="button" class="btn btn-outline-dark w-100" @click="setManually()">Add manually</button>
			</div>
		</div>

		<template v-if="manual">
			<div class="_warning mb-2">
				<i class="_icon_warning bg-warning mb-2"></i>
				<div class="fw-bold mb-2">Verify Before Connecting</div>
				<div class="text-secondary">Adding users via User ID skips the cryptographic verification. Ensure you received the ID from a trusted source.</div>
			</div>

			<div class="d-flex mb-2">
				<input class="form-control" placeholder="User ID of trusted contact (u_...)" type="text" v-model="userIdInput" />
				<button class="btn btn-dark ms-2" v-if="userIdInput" @click="addManually()">Add</button>
			</div>
		</template>

		<div class="row justify-content-center gx-2 mb-2 mt-3" v-if="contact">
			<div class="_divider mb-3">
				{{ isInContacts ? 'Existing contact' : 'Contact found' }}
			</div>
			<div class="fs-4 mb-4 text-center">
				<span class="fw-bold">{{ contact.name ? contact.name : 'Unnamed' }}</span>
				<span class="text-secondary ms-2" v-if="contact.user_hash">[{{ contact.user_hash.slice(-5) }}]</span>
			</div>

			<div class="col-30">
				<button type="button" class="btn btn-dark btn-lg w-100" @click="addContact()">
					{{ isInContacts ? 'Open contact' : 'Save contact' }}
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss">
@import '@/scss/variables.scss';
._warning {
	border-radius: $blockRadiusSm;
	padding: 1rem;
	background-color: rgba($warning, 0.2);
	text-align: center;

	._icon_warning {
		height: 2rem;
	}
}
</style>

<script setup>
import { useMenu } from '@/composables/useMenu';

import { ref, inject, onMounted, computed } from 'vue';
import Account_Item from '@/components/Account_Item.vue';
import QRScannerEngine from '@/components/engines/QRScannerEngine.vue';

const $userPQ = inject('$userPQ');
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');
const $loader = inject('$loader');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const scannerEngineRef = ref(null);

const hasCamera = ref();
const contact = ref(null);
const manual = ref();
const scanning = ref(false);
const countdown = ref();
const userIdInput = ref();

const { inputData } = defineProps({ inputData: { type: Object } });

onMounted(async () => {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		hasCamera.value = devices.some((device) => device.kind === 'videoinput');
	} catch (error) {
		console.error('Error checking camera availability:', error);
	}

	if (hasCamera.value && inputData?.startScan) {
		setTimeout(() => toggleScanner(), 100);
	}
});

const onScanning = (isScanning) => {
	scanning.value = isScanning;
};

const onCountdown = (count) => {
	countdown.value = count;
	if (count > 0) {
		$loader.show();
	} else {
		$loader.hide();
	}
};

const onHandshakeCompleted = (peerData) => {
	contact.value = peerData;
};

async function toggleScanner() {
	manual.value = false;
	contact.value = null;
	userIdInput.value = null;
	
	if (scannerEngineRef.value) {
		await scannerEngineRef.value.toggleScanner();
	}
}

const isInContacts = computed(() => {
	if (!contact.value || !contact.value.user_hash) return false;
	return !!$userPQ.contactsMap[contact.value.user_hash];
});

function closeModal() {
	$mitt.emit('modal::close');
}

const addContact = async () => {
	try {
		if ($userPQ.currentUserHash === contact.value.user_hash) {
			$swal.fire({
				icon: 'warning',
				title: 'It`s your own account',
				timer: 15000,
			});
			return;
		}

		if (isInContacts.value) {
			$swal.fire({
				icon: 'success',
				title: 'Contact already in your list',
				timer: 15000,
			});
			const existingContact = $userPQ.contactsMap[contact.value.user_hash];
			manual.value = false;
			$router.push({ name: 'contact', params: { address: existingContact.address } });
			closeModal();
			return;
		}

		if (!contact.value.contact_pkey) {
			console.warn("Saving contact without contact_pkey. Encryption might not work.");
		}

		await $userPQ.saveContact(contact.value.user_hash, {
			name: contact.value.name,
			notes: '',
			hidden: false,
			contact_pkey: contact.value.contact_pkey
		});

		$swal.fire({
			icon: 'success',
			title: 'Contact added',
			footer: 'Now you can name it and make notes',
			timer: 15000,
		});
		
		closeMenu();
		$router.push({ name: 'contact', params: { address: contact.value.user_hash } });
		closeModal();
	} catch (error) {
		console.log('addContact error', error);
	}
};

const setManually = async () => {
	if (scannerEngineRef.value) {
		scannerEngineRef.value.stopScan();
	}
	contact.value = null;
	manual.value = true;
	scanning.value = false;
	userIdInput.value = null;
};

const addManually = async () => {
	const userHash = userIdInput.value?.trim();
	if (!userHash || !userHash.startsWith('u_')) {
		$swal.fire({
			icon: 'warning',
			title: 'Invalid user ID format. Must start with u_',
			timer: 15000,
		});
		return;
	}

	const networkUser = $userPQ.allNetworkUsers.find(u => u.user_hash === userHash);

	contact.value = {
		user_hash: userHash,
		address: userHash,
		name: networkUser ? networkUser.name : 'Unknown User',
		contact_pkey: networkUser ? networkUser.contact_pkey : null
	};
	
	manual.value = false;
	addContact();
};
</script>