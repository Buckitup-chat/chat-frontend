const fs = require('fs');

const path = 'src/components/engines/QRScannerEngine.vue';
let content = fs.readFileSync(path, 'utf8');

const scriptStart = content.indexOf('<script setup>');
const scriptEnd = content.indexOf('</script>') + '</script>'.length;

const newScript = `<script setup>
import { ref, reactive, inject, onMounted, onBeforeUnmount } from 'vue';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { randomBytes } from '@noble/post-quantum/utils.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { QWBPConnection, base64urlEncode, base64urlDecode } from 'qwbp';

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
let qwbpConnection = null;

const scanning = ref(false);

const getInitialState = () => ({
	myNonce: null,
	mySigPeerNonce: null,
	mySigHashNonce: null,
	peerHash: null,
	peerEccPub: null,
	peerNonce: null,
	completed: false,
	status: 'scanning' // scanning, detected, verified
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
	stopScan();
	if (qrScanner) {
		qrScanner.destroy();
	}
});

const updateQr = () => {
	if (qrCodeRef.value && qwbpConnection) {
		try {
			const payloadBytes = qwbpConnection.getQRPayload();
			const payloadBase64 = base64urlEncode(payloadBytes);
			const msg = \`QWBP:\${payloadBase64}\`;
			
			let color = props.options.scanningColor;
			if (state.status === 'detected') color = props.options.detectedColor;
			if (state.status === 'verified') color = props.options.verifiedColor;

			QRCode.toCanvas(qrCodeRef.value, msg, {
				errorCorrectionLevel: 'L',
				height: 360,
				width: 360,
				quality: 1,
				margin: 0,
				color: { dark: color },
			});
		} catch (error) {
			console.error('Failed to generate QWBP QR code:', error);
		}
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
	if (qwbpConnection) {
		qwbpConnection.close();
		qwbpConnection = null;
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
		
		// Initialize QWBP Connection
		if (qwbpConnection) {
			qwbpConnection.close();
		}
		qwbpConnection = new QWBPConnection({
			iceServers: [
				{ urls: 'stun:stun.l.google.com:19302' },
				{ urls: 'stun:stun1.l.google.com:19302' }
			]
		});
		await qwbpConnection.initialize();

		setupDataChannelListener();

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

const setupDataChannelListener = () => {
	qwbpConnection.onDataChannel((channel) => {
		console.log('QWBP DataChannel opened! Role:', qwbpConnection.assignedRole);
		
		channel.onmessage = async (event) => {
			try {
				const msg = JSON.parse(event.data);
				await handleDataChannelMessage(msg, channel);
			} catch (e) {
				console.error('Error handling data channel message', e);
			}
		};

		// If we are the offerer, we initiate the handshake
		if (qwbpConnection.assignedRole === 'offerer') {
			sendHandshakeA(channel);
		}
	});
};

const sendHandshakeA = (channel) => {
	const myHash = $userPQ.currentUserHash;
	const myEccPubBytes = atob($userPQ.currentUser.contact_pkey);
	const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));
	
	channel.send(JSON.stringify({
		type: 'A',
		hash: myHash,
		eccPub: myEccPub,
		nonce: state.myNonce
	}));
};

const handleDataChannelMessage = async (msg, channel) => {
	const myHash = $userPQ.currentUserHash;

	if (msg.type === 'A') {
		state.peerHash = msg.hash;
		state.peerEccPub = msg.eccPub;
		state.peerNonce = msg.nonce;
		
		// Generate signatures over raw bytes
		const peerNonceBytes = hexToBytes(state.peerNonce);
		state.mySigPeerNonce = await $userPQ.signContactChallenge(peerNonceBytes);
		
		const hashBytes = new TextEncoder().encode(myHash);
		const hashPlusNonce = new Uint8Array(hashBytes.length + peerNonceBytes.length);
		hashPlusNonce.set(hashBytes);
		hashPlusNonce.set(peerNonceBytes, hashBytes.length);
		
		state.mySigHashNonce = await $userPQ.signContactChallenge(hashPlusNonce);
		
		const myEccPubBytes = atob($userPQ.currentUser.contact_pkey);
		const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));

		channel.send(JSON.stringify({
			type: 'B',
			hash: myHash,
			eccPub: myEccPub,
			nonce: state.myNonce,
			sigPeerNonce: bytesToHex(state.mySigPeerNonce),
			sigHashNonce: bytesToHex(state.mySigHashNonce)
		}));

	} else if (msg.type === 'B') {
		state.peerHash = msg.hash;
		state.peerEccPub = msg.eccPub;
		state.peerNonce = msg.nonce;
		
		// Verify Sig(myNonce)
		const myNonceBytes = hexToBytes(state.myNonce);
		const isValid1 = secp.verify(hexToBytes(msg.sigPeerNonce), sha256(myNonceBytes), hexToBytes(state.peerEccPub));
		
		// Verify Sig(peerHash + myNonce)
		const peerHashBytes = new TextEncoder().encode(state.peerHash);
		const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
		expectedHashPlusNonce.set(peerHashBytes);
		expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
		const isValid2 = secp.verify(hexToBytes(msg.sigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(state.peerEccPub));
		
		if (isValid1 && isValid2) {
			// Generate signatures over raw bytes
			const peerNonceBytes = hexToBytes(state.peerNonce);
			state.mySigPeerNonce = await $userPQ.signContactChallenge(peerNonceBytes);
			
			const myHashBytes = new TextEncoder().encode(myHash);
			const hashPlusNonce = new Uint8Array(myHashBytes.length + peerNonceBytes.length);
			hashPlusNonce.set(myHashBytes);
			hashPlusNonce.set(peerNonceBytes, myHashBytes.length);
			
			state.mySigHashNonce = await $userPQ.signContactChallenge(hashPlusNonce);
			
			channel.send(JSON.stringify({
				type: 'C',
				sigPeerNonce: bytesToHex(state.mySigPeerNonce),
				sigHashNonce: bytesToHex(state.mySigHashNonce)
			}));

			state.status = 'verified';
			updateQr();
			finishHandshake();
		} else {
			console.warn("Invalid signature from peer (B)");
		}

	} else if (msg.type === 'C') {
		// Verify Sig(myNonce)
		const myNonceBytes = hexToBytes(state.myNonce);
		const isValid1 = secp.verify(hexToBytes(msg.sigPeerNonce), sha256(myNonceBytes), hexToBytes(state.peerEccPub));
		
		// Verify Sig(peerHash + myNonce)
		const peerHashBytes = new TextEncoder().encode(state.peerHash);
		const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
		expectedHashPlusNonce.set(peerHashBytes);
		expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
		
		const isValid2 = secp.verify(hexToBytes(msg.sigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(state.peerEccPub));
		
		if (isValid1 && isValid2) {
			state.status = 'verified';
			updateQr();
			finishHandshake();
		} else {
			console.warn("Invalid signature from peer (C)");
		}
	}
};

const readQr = async (msg) => {
	try {
		if (!msg.startsWith('QWBP:')) {
			// Ignore non-QWBP QR codes to avoid conflicts
			return;
		}
		
		// Change status to detected once we see a valid prefix
		if (state.status !== 'detected' && state.status !== 'verified') {
			state.status = 'detected';
			updateQr();
			if ('vibrate' in navigator) navigator.vibrate([50]);
		}

		const base64Payload = msg.substring(5); // Remove 'QWBP:'
		const payloadBytes = base64urlDecode(base64Payload);

		if (qwbpConnection && qwbpConnection.connectionState !== 'connected') {
			await qwbpConnection.processScannedPayload(payloadBytes);
		}
	} catch (error) {
		console.error('readQr error:', error);
	}
};

const finishHandshake = () => {
	if (state.completed) return; // Prevent double trigger
	state.completed = true;
	
	if ('vibrate' in navigator) navigator.vibrate([500, 100, 500, 100, 500]);
	
	if (qrScanner) {
		qrScanner.stop();
	}
	
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

</script>`;

content = content.substring(0, scriptStart) + newScript + content.substring(scriptEnd);
fs.writeFileSync(path, content, 'utf8');
