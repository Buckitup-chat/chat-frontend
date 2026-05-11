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
		<template v-if="!scanning && !contact && !publicKey && !countdown">
			<!--div class="_divider my-3">Your account</div-->

			<div class="px-3 d-flex justify-content-center">
				<Account_Item :self="true" />
			</div>
		</template>

		<template v-if="!scanning && !contact && !publicKey && !manual && !countdown">
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

		<div class="_qrh">
			<div class="_qrh_wrapper" :class="{ _hidden: !showQr }">
				<div class="_qrh_container">
					<canvas ref="qrCode"></canvas>
				</div>
			</div>
			<div class="_qrh_scanner" :class="{ _hidden: !showCamera }">
				<video ref="qrScannerEl"></video>
			</div>
		</div>

		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="!contact && !countdown">
			<div class="col-30">
				<button type="button" class="btn btn-dark btn-lg w-100" @click="toggleScanner()">
					<span v-if="!scanning">Start handshake scanning</span>
					<span v-if="scanning">Scanning... Click to stop</span>
				</button>
			</div>
		</div>

		<div class="row justify-content-center gx-2 mt-3 mb-2" v-if="contact">
			<div class="col-30">
				<button type="button" class="btn btn-outline-dark w-100" @click="toggleScanner()">
					{{ publicKey ? 'Start handshake scanning' : 'Scan again' }}
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
				<div class="text-secondary">Sharing public keys over unsecured channels may expose you to risks. Always verify the key’s authenticity before adding a contact.</div>
			</div>

			<div class="d-flex mb-2">
				<input class="form-control" placeholder="Public key of trusted contact" type="text" v-model="publicKey" />
				<button class="btn btn-dark ms-2" v-if="publicKey" @click="addManually()">Add</button>
			</div>
		</template>

		<div class="row justify-content-center gx-2 mb-2 mt-3" v-if="contact">
			<div class="_divider mb-3">
				{{ isInContacts ? 'Existing contact' : 'Contact found' }}
			</div>
			<div class="fs-4 mb-4 text-center">
				<span class="fw-bold">{{ contact.name ? contact.name : 'Unnamed' }}</span>
				<span class="text-secondary ms-2">[{{ contact.publicKey.slice(-5) }}]</span>
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

._qrh {
	overflow: hidden;
	position: relative;

	._qrh_scanner {
		width: 100%;
		z-index: 2;
		border-radius: 1rem;
		overflow: hidden;
		pointer-events: none;
		max-height: 400px;

		&._hidden {
			position: absolute;
			top: -9999px;
			height: 1px;
			max-height: unset;
			opacity: 0 !important;
		}

		video {
			width: 100%;
		}
	}

	._qrh_wrapper {
		justify-content: center;
		z-index: 1;
		display: flex;

		&._hidden {
			height: 0px;
			display: none;
		}
		._qrh_container {
			width: 100% !important;
			max-width: 470px !important;
			canvas {
				width: 100% !important;
				height: auto !important;
			}
		}
	}
}
</style>

<script setup>
import { ref, inject, onMounted, onBeforeUnmount, computed } from 'vue';
import QrScanner from 'qr-scanner';
import QRCode from 'qrcode';
import Account_Item from '@/components/Account_Item.vue';
import { randomBytes } from '@noble/post-quantum/utils.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const $userPQ = inject('$userPQ');
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');
const $loader = inject('$loader');
const $menuOpened = inject('$menuOpened');

const hasCamera = ref();
const contact = ref(null);
const qrCode = ref(null);
const qrScanner = ref(null);
const qrScannerEl = ref(null);
const manual = ref();
const scanning = ref();
const showQr = ref();
const showCamera = ref();

const countdown = ref();

const options = {
	scanningColor: '#000',
	detectedColor: '#8e2b77',
	verifiedColor: '#611e52',
};

const state = ref({
	step: 1, // 1: QR1(A), 2: QR2(B), 3: QR3(A), 4: Done(B)
	myNonce: null,
	mySigPeerNonce: null,
	mySigHashNonce: null,
	peerHash: null,
	peerEccPub: null,
	peerNonce: null,
	completed: false,
});

const { inputData } = defineProps({ inputData: { type: Object } });

onMounted(async () => {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		hasCamera.value = devices.some((device) => device.kind === 'videoinput');
	} catch (error) {
		console.error('Error checking camera availability:', error);
	}

	if (hasCamera.value) {
		qrScanner.value = new QrScanner(qrScannerEl.value, (result) => readQr(result.data), {
			returnDetailedScanResult: true,
			preferredCamera: 'user',
			highlightScanRegion: true,
			highlightCodeOutline: true,
			calculateScanRegion: (video) => {
				const width = video.videoWidth;
				const height = video.videoHeight;
				const scanSize = 0.95;
				return {
					x: (width * (1 - scanSize)) / 2,
					y: (height * (1 - scanSize)) / 2,
					width: width * scanSize,
					height: height * scanSize,
				};
			},
		});

		if (inputData?.startScan) toggleScanner();
	}
});

onBeforeUnmount(() => {
	if (countdownInterval) clearInterval(countdownInterval);
	if (stopScanTimeout) clearTimeout(stopScanTimeout);
	try {
		qrScanner.value.dispose();
	} catch (error) {}
});

let countdownInterval = null;
async function toggleScanner() {
	manual.value = false;
	contact.value = null;
	publicKey.value = null;
	try {
		if (scanning.value && qrScanner.value) {
			await stopScan();
			updateQr();
			return;
		}
		reset();
		$loader.show();

		await wait(100);

		await qrScanner.value.start();
		$loader.hide();
		showCamera.value = true;

		countdown.value = 1;
		countdownInterval = setInterval(() => {
			countdown.value -= 1;
			if (countdown.value <= 0) {
				clearInterval(countdownInterval);
				showCamera.value = false;
				scanning.value = true;

				state.value.myNonce = bytesToHex(randomBytes(16));
				showQr.value = true;
				updateQr();
			}
		}, 1000);
	} catch (error) {
		console.error('Init Scanning error:', error);
		$loader.hide();
	}
}

let stopScanTimeout = null;
function startAutoStopCountdown(delay = 1000) {
	if (stopScanTimeout) clearTimeout(stopScanTimeout);
	stopScanTimeout = setTimeout(() => stopScan(), delay);
}

const readQr = async (msg) => {
	try {
		if (!msg.startsWith('PQ1:')) return;
		const parts = msg.split(':');
		const type = parts[1];

		const myHash = $userPQ.currentUserHash;
		const myEccPubBytes = atob($userPQ.currentUser.contact_pkey);
		const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));

		if (type === 'A') {
			if (state.value.step >= 2) return;
			state.value.peerHash = parts[2];
			state.value.peerEccPub = parts[3];
			state.value.peerNonce = parts[4];
			
			state.value.mySigPeerNonce = await $userPQ.signContactChallenge(state.value.peerNonce);
			const hashPlusNonce = sha256(new TextEncoder().encode(myHash + state.value.peerNonce));
			state.value.mySigHashNonce = await $userPQ.signContactChallenge(bytesToHex(hashPlusNonce));
			
			state.value.step = 2;
			if ('vibrate' in navigator) navigator.vibrate([50]);
			updateQr();
		} else if (type === 'B') {
			if (state.value.step >= 3) return;
			const peerHash = parts[2];
			const peerEccPub = parts[3];
			const peerNonce = parts[4];
			const peerSigNonce = parts[5];
			const peerSigHashNonce = parts[6];

			state.value.peerHash = peerHash;
			state.value.peerEccPub = peerEccPub;
			state.value.peerNonce = peerNonce;
			
			const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(hexToBytes(state.value.myNonce)), hexToBytes(peerEccPub));
			const expectedHashPlusNonce = sha256(new TextEncoder().encode(peerHash + state.value.myNonce));
			const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(peerEccPub));
			
			if (isValid1 && isValid2) {
				state.value.mySigPeerNonce = await $userPQ.signContactChallenge(peerNonce);
				const hashPlusNonce = sha256(new TextEncoder().encode(myHash + peerNonce));
				state.value.mySigHashNonce = await $userPQ.signContactChallenge(bytesToHex(hashPlusNonce));
				
				state.value.step = 3;
				state.value.completed = true;
				finishHandshake();
				updateQr();
			} else {
				console.warn("Invalid signature from peer (B)");
			}
		} else if (type === 'C') {
			if (state.value.step !== 2) return;
			const peerSigNonce = parts[2];
			const peerSigHashNonce = parts[3];
			
			const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(hexToBytes(state.value.myNonce)), hexToBytes(state.value.peerEccPub));
			const expectedHashPlusNonce = sha256(new TextEncoder().encode(state.value.peerHash + state.value.myNonce));
			const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(state.value.peerEccPub));
			
			if (isValid1 && isValid2) {
				state.value.step = 4;
				state.value.completed = true;
				finishHandshake();
				updateQr();
			} else {
				console.warn("Invalid signature from peer (C)");
			}
		}
	} catch (error) {
		console.error('readQr error:', error);
	}
};

const updateQr = async () => {
	if (qrCode.value && state.value.myNonce) {
		const myHash = $userPQ.currentUserHash;
		const myEccPubBytes = atob($userPQ.currentUser.contact_pkey);
		const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));
		
		let msg = '';
		let color = options.scanningColor;

		if (state.value.step === 1) {
			msg = `PQ1:A:${myHash}:${myEccPub}:${state.value.myNonce}`;
		} else if (state.value.step === 2) {
			msg = `PQ1:B:${myHash}:${myEccPub}:${state.value.myNonce}:${state.value.mySigPeerNonce}:${state.value.mySigHashNonce}`;
			color = options.detectedColor;
		} else if (state.value.step === 3 || state.value.step === 4) {
			msg = `PQ1:C:${state.value.mySigPeerNonce}:${state.value.mySigHashNonce}`;
			color = options.verifiedColor;
		}

		QRCode.toCanvas(qrCode.value, msg, {
			errorCorrectionLevel: 'L',
			height: 360,
			width: 360,
			quality: 1,
			margin: 0,
			color: { dark: color },
		});
	}
};

const finishHandshake = () => {
	if ('vibrate' in navigator) navigator.vibrate([500, 100, 500, 100, 500]);
	
	// Lookup user in network
	const networkUser = $userPQ.allNetworkUsers.find(u => u.user_hash === state.value.peerHash);
	
	contact.value = {
		address: state.value.peerHash,
		publicKey: state.value.peerHash,
		name: networkUser ? networkUser.name : 'Unknown User',
		user_hash: state.value.peerHash,
		contact_pkey: state.value.peerEccPub
	};

	startAutoStopCountdown();
};

const isInContacts = computed(() => {
	if (!contact.value) return false;
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
			contact.value = $userPQ.contactsMap[contact.value.user_hash];
			manual.value = false;
			$router.push({ name: 'contact', params: { address: contact.value.address } });
			closeModal();
			return;
		}

		await $userPQ.saveContact(contact.value.user_hash, {
			name: contact.value.name,
			notes: '',
			hidden: false
		});

		$swal.fire({
			icon: 'success',
			title: 'Contact added',
			footer: 'Now you can name it and make notes',
			timer: 15000,
		});
		$menuOpened.value = false;
		$router.push({ name: 'contact', params: { address: contact.value.address } });
		closeModal();
	} catch (error) {
		console.log('addContact error', error);
	}
};

const setManually = async () => {
	stopScan();
	contact.value = null;
	manual.value = true;
	scanning.value = false;
	publicKey.value = null;
};

const publicKey = ref();
const addManually = async () => {
	const userHash = publicKey.value?.trim();
	if (!userHash || !userHash.startsWith('u_')) {
		$swal.fire({
			icon: 'warning',
			title: 'Invalid user hash',
			timer: 15000,
		});
		publicKey.value = null;
		return;
	}

	const networkUser = $userPQ.allNetworkUsers.find(u => u.user_hash === userHash);

	contact.value = {
		publicKey: userHash,
		address: userHash,
		user_hash: userHash,
		name: networkUser ? networkUser.name : 'Unknown User'
	};
	manual.value = false;
	addContact();
};

const reset = () => {
	state.value.step = 1;
	state.value.completed = false;
	state.value.myNonce = null;
	state.value.mySigPeerNonce = null;
	state.value.mySigHashNonce = null;
	state.value.peerHash = null;
	state.value.peerEccPub = null;
	state.value.peerNonce = null;
};

const stopScan = async () => {
	scanning.value = false;
	showQr.value = false;
	if (qrScanner.value) {
		try {
			await qrScanner.value.stop();
		} catch (error) {}
	}
};

const wait = (delay = 500) => {
	return new Promise((resolve) =>
		setTimeout(() => resolve(), delay)
	);
};
</script>
