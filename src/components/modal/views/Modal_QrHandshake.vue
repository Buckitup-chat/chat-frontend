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
				Hold the phones face to face, screens towards each other, 25–40 cm apart: closer, the front cameras do not focus. Each phone shows its code and reads the other's; the phones
				vibrate when the key is proved, and the contact appears for adding with six digits that both screens show.
			</div>
		</template>

		<!-- Display QR Code for Current State -->
		<div class="text-center text-secondary fw-bold mb-1 fs-4" v-if="countdown">Turn phones to each other</div>
		<div class="text-center fw-bold fs-1" v-if="countdown">
			{{ countdown }}
		</div>

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
			<div class="fs-4 mb-2 text-center">
				<span class="fw-bold">{{ contact.name ? contact.name : 'Unnamed' }}</span>
				<span class="text-secondary ms-2" v-if="contact.user_hash">[{{ contact.user_hash.slice(2, 7) }}]</span>
			</div>
			<div class="text-center mb-2" v-if="contact.viaHandshake">
				<div :class="contact.confirmed ? 'text-success' : 'text-warning'">
					{{ contact.confirmed ? 'Contact confirmed' : 'Key verified in person; not yet confirmed' }}
				</div>
				<div class="text-secondary small" v-if="!contact.confirmed">{{ notConfirmedReason(contact) }}</div>
				<div class="small mt-1" v-if="contact.sas">
					Code <span class="fw-bold" data-test="contact-sas">{{ contact.sas }}</span> — the same on both phones
				</div>
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
import { userPQStore } from '@/store/userPQ.store';

import { useLoader } from '@/composables/useLoader';


import { useMenu } from '@/composables/useMenu';

import { ref, inject, onMounted, computed } from 'vue';
import Account_Item from '@/components/Account_Item.vue';
import QRScannerEngine from '@/components/engines/QRScannerEngine.vue';
import { prefetchRelay } from '@/lib/data/turnCredentials';
import errorMessage from '@/utils/errorMessage';

const $userPQ = userPQStore();
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');
const $loader = useLoader();
const { close: closeMenu } = useMenu();

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
	// The relay credentials are asked for here, one screen before the scanner
	// and only when there is a camera to scan with: a session takes what is
	// cached, or waits at most 1 s for them.
	if (hasCamera.value) void prefetchRelay();

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

// The engine decides: `confirmed` comes with the card the handshake verified
// (its certified key is the one proved in person, and its identity signed the
// session over the channel). confirmContact checks that card again before
// anything is saved (docs/task-handshake-pq2.md §6).
const onHandshakeCompleted = (result) => {
	contact.value = { ...result, viaHandshake: true };
};

// Why a handshake ended verified in person only, by the engine's cause: the
// one place this is worded.
const NOT_CONFIRMED = {
	'no-channel': 'Check that both phones are online, or scan again on a shared Wi-Fi.',
	'no-address': 'This phone has no network to reach the other one. Check that both phones are online, or scan again on a shared Wi-Fi.',
	'no-card': 'Your profile card is not published yet, so the other phone cannot confirm you. Try again once you are online.',
	'no-signature': 'This phone could not sign the confirmation. Sign in again, then scan again.',
	'no-confirmation': 'The phones connected, but the other one sent no confirmation. Scan again.',
	refused: 'Their profile card does not certify the key their phone showed: this is not confirmed as their account.',
	deleted: 'This account is deleted: a deleted account cannot be confirmed.',
	'peer-unable': 'The other phone could not confirm its account: its profile card may not be published yet. Try again once it is online.',
};
const notConfirmedReason = (c) => NOT_CONFIRMED[c.cause] ?? NOT_CONFIRMED['no-channel'];

const onDeviceOnly = (saved) => !!saved?.status && saved.status !== 'synced';
const notSyncedFooter = (saved) => {
	if (!onDeviceOnly(saved)) return null;
	return saved.status === 'awaiting-approval'
		? 'It reaches the server once the device owner approves your account'
		: 'It reaches the server when this device can send it';
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

		// Only the handshake confirms: a contact added by id never carries `confirmed`.
		const confirmed = !!contact.value.confirmed;
		const notConfirmed = !!contact.value.viaHandshake && !confirmed;
		const notConfirmedFooter = notConfirmed ? notConfirmedReason(contact.value) : undefined;
		const sasText = confirmed && contact.value.sas ? `Code ${contact.value.sas}` : undefined;

		if (isInContacts.value) {
			// Scanned in person: that is what confirms it, with the card the
			// handshake verified.
			const saved = confirmed ? await $userPQ.confirmContact(contact.value.user_hash, contact.value.card, contact.value.contact_pkey) : null;
			$swal.fire({
				icon: notConfirmed ? 'warning' : 'success',
				title: onDeviceOnly(saved)
					? 'Contact confirmed on this device'
					: confirmed ? 'Contact confirmed' : notConfirmed ? 'Key verified in person; not yet confirmed' : 'Contact already in your list',
				text: sasText,
				footer: notSyncedFooter(saved) ?? notConfirmedFooter,
				timer: 15000,
			});
			manual.value = false;
			$router.push({ name: 'contact', params: { address: contact.value.user_hash } });
			closeModal();
			return;
		}

		if (!contact.value.contact_pkey) {
			console.warn("Saving contact without contact_pkey. Encryption might not work.");
		}

		const fields = { name: contact.value.name, notes: '', hidden: false };
		const saved = confirmed
			? await $userPQ.confirmContact(contact.value.user_hash, contact.value.card, contact.value.contact_pkey, fields)
			: await $userPQ.saveContact(contact.value.user_hash, { ...fields, contact_pkey: contact.value.contact_pkey });

		$swal.fire({
			icon: notConfirmed ? 'warning' : 'success',
			title: onDeviceOnly(saved)
				? (confirmed ? 'Contact confirmed on this device' : 'Contact added on this device')
				: (confirmed ? 'Contact added and confirmed' : notConfirmed ? 'Key verified in person; not yet confirmed' : 'Contact added'),
			text: sasText,
			footer: notSyncedFooter(saved) ?? notConfirmedFooter ?? 'Now you can name it and make notes',
			timer: 15000,
		});
		
		closeMenu();
		$router.push({ name: 'contact', params: { address: contact.value.user_hash } });
		closeModal();
	} catch (error) {
		// Nothing was saved: say so, and stay here so it can be tried again.
		$swal.fire({
			icon: 'error',
			title: 'Contact not saved',
			text: errorMessage(error),
		});
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