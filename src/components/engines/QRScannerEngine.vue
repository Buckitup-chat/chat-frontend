<template>
  <div class="_qrh">
    <div class="_qrh_wrapper" v-show="scanning || state.completed" :class="{ _hidden: !scanning && !state.completed }">
      <div class="_qrh_container">
        <canvas ref="qrCodeRef"></canvas>
      </div>
    </div>
    <div class="_qrh_scanner" :class="{ _hidden: !scanning }" id="qrScannerWrap">
      <video ref="qrScannerRef"></video>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, inject, onMounted, onBeforeUnmount } from 'vue';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { randomBytes } from '@noble/post-quantum/utils.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const $userPQ = inject('$userPQ');

const props = defineProps({
	options: {
		type: Object,
		default: () => ({
			scanningColor: '#000',
			detectedColor: '#8e2b77',
			verifiedColor: '#611e52',
		}),
	},
});

const emit = defineEmits(['scanning', 'countdown', 'completed']);

const qrCodeRef = ref(null);
const qrScannerRef = ref(null);
let qrScanner = null;

const scanning = ref(false);

const getInitialState = () => ({
	step: 1, // 1: QR1(A), 2: QR2(B), 3: QR3(C), 4: Done
	myNonce: null,
	mySigPeerNonce: null,
	mySigHashNonce: null,
	peerHash: null,
	peerEccPub: null,
	peerNonce: null,
	completed: false,
});

const state = reactive(getInitialState());

onMounted(() => {
	if (qrScannerRef.value) {
		qrScanner = new QrScanner(qrScannerRef.value, (result) => readQr(result.data), {
			returnDetailedScanResult: true,
			preferredCamera: 'user',
			highlightScanRegion: true,
			highlightCodeOutline: true,
			calculateScanRegion: (video) => {
				const width = video.videoWidth;
				const height = video.videoHeight;
				const size = Math.min(width, height) * 0.95;
				return {
					x: (width - size) / 2,
					y: (height - size) / 2,
					width: size,
					height: size,
				};
			},
		});
	}
});

onBeforeUnmount(() => {
	if (qrScanner) {
		qrScanner.destroy();
	}
});

const updateQr = () => {
	if (qrCodeRef.value && state.myNonce) {
		const myHash = $userPQ.currentUserHash;
		const myEccPubBytes = atob($userPQ.currentUser.contact_pkey);
		const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));
		
		let msg = '';
		let color = props.options.scanningColor;

		if (state.step === 1) {
			msg = `PQ1:A:${myHash}:${myEccPub}:${state.myNonce}`;
		} else if (state.step === 2) {
			msg = `PQ1:B:${myHash}:${myEccPub}:${state.myNonce}:${state.mySigPeerNonce}:${state.mySigHashNonce}`;
			color = props.options.detectedColor;
		} else if (state.step >= 3) {
			msg = `PQ1:C:${state.mySigPeerNonce}:${state.mySigHashNonce}`;
			color = props.options.verifiedColor;
		}

		QRCode.toCanvas(qrCodeRef.value, msg, {
			errorCorrectionLevel: 'L',
			height: 360,
			width: 360,
			quality: 1,
			margin: 0,
			color: { dark: color },
		});
	}
};

let scanSessionId = 0;

const stopScan = () => {
	if (qrScanner) {
		qrScanner.stop();
		scanning.value = false;
		state.completed = false;
		scanSessionId++; // Invalidate any ongoing countdowns
		emit('scanning', scanning.value);
	}
};

const wait = (delay = 500) => new Promise((resolve) => setTimeout(resolve, delay));

const showCountdown = async (seconds, sessionId) => {
	for (let i = seconds; i > 0; i--) {
		if (scanSessionId !== sessionId || !scanning.value) return false;
		emit('countdown', i);
		await wait(1000);
	}
	if (scanSessionId !== sessionId || !scanning.value) return false;
	emit('countdown', 0);
	return true;
};

const toggleScanner = async () => {
	try {
		if (scanning.value && qrScanner) {
			stopScan();
			return;
		}
		
		Object.assign(state, getInitialState());
		if (qrCodeRef.value) {
			const ctx = qrCodeRef.value.getContext('2d');
			ctx.clearRect(0, 0, qrCodeRef.value.width, qrCodeRef.value.height);
		}
		scanning.value = true;
		scanSessionId++;
		const currentSession = scanSessionId;
		
		emit('scanning', scanning.value);
		await wait(100);
		await qrScanner.start();

		const completedCountdown = await showCountdown(3, currentSession);
		if (!completedCountdown) return;

		state.myNonce = bytesToHex(randomBytes(16));
		updateQr();
	} catch (error) {
		console.error('Init Scanning error:', error);
	}
};

const readQr = async (msg) => {
	try {
		if (!msg.startsWith('PQ1:')) return;
		const parts = msg.split(':');
		const type = parts[1];

		const myHash = $userPQ.currentUserHash;

		if (type === 'A') {
			if (state.step >= 2) return;
			state.peerHash = parts[2];
			state.peerEccPub = parts[3];
			state.peerNonce = parts[4];
			
			// Generate signatures over raw bytes
			const peerNonceBytes = hexToBytes(state.peerNonce);
			state.mySigPeerNonce = await $userPQ.signContactChallenge(peerNonceBytes);
			
			const hashBytes = new TextEncoder().encode(myHash);
			const hashPlusNonce = new Uint8Array(hashBytes.length + peerNonceBytes.length);
			hashPlusNonce.set(hashBytes);
			hashPlusNonce.set(peerNonceBytes, hashBytes.length);
			
			state.mySigHashNonce = await $userPQ.signContactChallenge(hashPlusNonce);
			
			state.step = 2;
			if ('vibrate' in navigator) navigator.vibrate([50]);
			updateQr();

		} else if (type === 'B') {
			if (state.step >= 3) return;
			const peerHash = parts[2];
			const peerEccPub = parts[3];
			const peerNonce = parts[4];
			const peerSigNonce = parts[5];
			const peerSigHashNonce = parts[6];

			state.peerHash = peerHash;
			state.peerEccPub = peerEccPub;
			state.peerNonce = peerNonce;
			
			// Verify Sig(myNonce)
			const myNonceBytes = hexToBytes(state.myNonce);
			const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(myNonceBytes), hexToBytes(peerEccPub));
			
			// Verify Sig(peerHash + myNonce)
			const peerHashBytes = new TextEncoder().encode(peerHash);
			const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
			expectedHashPlusNonce.set(peerHashBytes);
			expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
			const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(peerEccPub));
			
			if (isValid1 && isValid2) {
				// Generate signatures over raw bytes
				const peerNonceBytes = hexToBytes(peerNonce);
				state.mySigPeerNonce = await $userPQ.signContactChallenge(peerNonceBytes);
				
				const myHashBytes = new TextEncoder().encode(myHash);
				const hashPlusNonce = new Uint8Array(myHashBytes.length + peerNonceBytes.length);
				hashPlusNonce.set(myHashBytes);
				hashPlusNonce.set(peerNonceBytes, myHashBytes.length);
				
				state.mySigHashNonce = await $userPQ.signContactChallenge(hashPlusNonce);
				
				state.step = 3;
				finishHandshake();
				updateQr();
			} else {
				console.warn("Invalid signature from peer (B)");
			}

		} else if (type === 'C') {
			if (state.step !== 2) return;
			const peerSigNonce = parts[2];
			const peerSigHashNonce = parts[3];
			
			// Verify Sig(myNonce)
			const myNonceBytes = hexToBytes(state.myNonce);
			const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(myNonceBytes), hexToBytes(state.peerEccPub));
			
			// Verify Sig(peerHash + myNonce)
			const peerHashBytes = new TextEncoder().encode(state.peerHash);
			const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
			expectedHashPlusNonce.set(peerHashBytes);
			expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
			
			const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(state.peerEccPub));
			
			if (isValid1 && isValid2) {
				state.step = 4;
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

const finishHandshake = () => {
	if (state.completed) return; // Prevent double trigger
	state.completed = true;
	
	if ('vibrate' in navigator) navigator.vibrate([500, 100, 500, 100, 500]);
	
	qrScanner.stop();
	
	// Lookup user in network to get name if available
	const networkUser = $userPQ.allNetworkUsers.find(u => u.user_hash === state.peerHash);
	const name = networkUser ? networkUser.name : 'Unknown User';

	// Emit candidate details for UI to show
	emit('completed', {
		user_hash: state.peerHash,
		contact_pkey: btoa(String.fromCharCode(...hexToBytes(state.peerEccPub))), // Re-encode to base64
		name: name
	});
	
	scanning.value = false;
	emit('scanning', scanning.value);
};

defineExpose({ toggleScanner, stopScan });

</script>

<style lang="scss">
._qrh {
	display: flex;
	flex-direction: column;
	align-items: center;
	max-height: 100dvh;

	._qrh_scanner {
		width: min(100%, 360px);
		aspect-ratio: 1;
		border-radius: 1rem;
		overflow: hidden;
		position: relative;

		&._hidden {
			position: absolute;
			top: -9999px;
			height: 1px;
			opacity: 0 !important;
		}

		video {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
	}

	._qrh_wrapper {
		width: min(100%, 360px);
		aspect-ratio: 1;
		display: flex;
		justify-content: center;
		align-items: center;
		margin-bottom: 0.75rem;

		&._hidden {
			height: 0px;
			display: none;
		}

		._qrh_container {
			width: 100%;
			height: 100%;
			canvas {
				width: 100% !important;
				height: 100% !important;
			}
		}
	}
}
</style>