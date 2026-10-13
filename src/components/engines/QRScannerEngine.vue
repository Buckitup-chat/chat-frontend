<template>
	<div class="_qrh">
		<div class="_qrh_wrapper" v-show="shown" :class="{ _hidden: !shown }" :data-stage="stage" :data-outcome="outcome?.kind">
			<div class="_qrh_container">
				<canvas ref="qrCodeRef"></canvas>
			</div>
		</div>
		<!-- The camera's own preview, small: the code is what the other phone reads. -->
		<div class="_qrh_scanner" :class="{ _hidden: !scanning }">
			<video ref="qrScannerRef" muted playsinline></video>
		</div>

		<div class="_qrh_status text-center" v-if="shown">
			<div class="text-secondary small mb-1" v-if="scanning && hint">{{ hint }}</div>
			<div class="small" v-if="scanning">
				Hold the phones face to face, 25–40 cm apart: closer, the front cameras do not focus.
			</div>
			<div class="text-secondary small" v-if="outcome?.kind === 'expired'">
				Session expired. Start again to make new codes.
			</div>
		</div>
		<div class="text-danger small text-center" v-if="cameraError">{{ cameraError }}</div>
	</div>
</template>

<script setup>
// The optical handshake v2 (docs/task-handshake-pq2.md): the camera and the
// QR code on screen; the result goes to the modal, which shows it. The
// protocol is the engine's
// (src/lib/handshake/engine.ts) and the module's (src/lib/pq/handshake.ts);
// this component runs one engine per session.
//
// A session id is checked after every await: a session restarted while the
// old one was still waiting (on the camera, on a signature, on QWBP) must not
// be drawn over, have its camera stopped, or be completed by the old one.
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { hexToBytes } from '@noble/hashes/utils';
import { userPQStore } from '@/store/userPQ.store';
import { HandshakeEngine } from '@/lib/handshake/engine';
import { QwbpChannel } from '@/lib/handshake/qwbpChannel';
import { relayIceServers } from '@/lib/data/turnCredentials';
import { toBase64, toBytes } from '@/lib/pq/signature';

const $userPQ = userPQStore();

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

const emit = defineEmits(['scanning', 'completed']);

const qrCodeRef = ref(null);
const qrScannerRef = ref(null);
const scanning = ref(false);
const stage = ref('idle');
const outcome = ref(null);
const cameraError = ref(null);
const shown = computed(() => scanning.value || !!outcome.value);

const STAGE_HINTS = {
	A: 'Showing my identity',
	B: 'Read their identity. Showing my signature',
	C: 'Their key is proved in person. Showing my channel offer',
	D: 'Showing my channel answer',
};
const hint = computed(() => STAGE_HINTS[stage.value] ?? '');

/** Size the code is drawn at; CSS scales it to the width of the screen. */
const QR_PIXELS = 720;
/** The same code read again within this time is the camera repeating itself. */
const REPEAT_MS = 400;

let qrScanner = null;
let engine = null;
let session = 0;
let lastScan = { text: '', at: 0 };

const log = (line) => console.debug('[handshake]', line);

onMounted(() => {
	if (!qrScannerRef.value) return;
	// qr-scanner prefers the browser's BarcodeDetector whenever the browser
	// lists QR among its formats, and falls back only when it throws. A browser
	// can list QR and still find nothing in a dense code on a screen; the
	// decoder qr-scanner ships reads the same in every browser.
	QrScanner._disableBarcodeDetector = true;
	qrScanner = new QrScanner(qrScannerRef.value, (result) => onScan(result.data), {
		returnDetailedScanResult: true,
		preferredCamera: 'user',
		maxScansPerSecond: 12,
		calculateScanRegion: (video) => {
			const size = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.95);
			const scaled = Math.min(size, 1080);
			return {
				x: Math.round((video.videoWidth - size) / 2),
				y: Math.round((video.videoHeight - size) / 2),
				width: size,
				height: size,
				downScaledWidth: scaled,
				downScaledHeight: scaled,
			};
		},
	});
});

onBeforeUnmount(() => {
	stopScan();
	qrScanner?.destroy();
	qrScanner = null;
});

const onScan = (text) => {
	const now = Date.now();
	if (text === lastScan.text && now - lastScan.at < REPEAT_MS) return;
	lastScan = { text, at: now };
	void engine?.read(text);
};

const colorOf = (s) => {
	if (s === 'B') return props.options.detectedColor;
	if (s === 'C' || s === 'D') return props.options.verifiedColor;
	return props.options.scanningColor;
};

const draw = (code, s) => {
	if (!qrCodeRef.value) return;
	QRCode.toCanvas(qrCodeRef.value, code, {
		errorCorrectionLevel: 'L',
		width: QR_PIXELS,
		margin: 2,
		color: { dark: colorOf(s) },
	}).catch((e) => log(`the code could not be drawn: ${e?.message ?? e}`));
};

const clearCode = () => {
	const canvas = qrCodeRef.value;
	canvas?.getContext?.('2d')?.clearRect(0, 0, canvas.width, canvas.height);
};

const stopCamera = () => {
	qrScanner?.stop();
};

const setScanning = (value) => {
	if (scanning.value === value) return;
	scanning.value = value;
	emit('scanning', value);
};

/** This account, as the engine needs it. */
const identity = () => {
	const userHash = $userPQ.currentUserHash;
	const contactPkey = $userPQ.currentUser?.contact_pkey;
	if (!userHash || !contactPkey) throw new Error('Sign in to add a contact in person');
	return {
		userHash,
		contactPkey: toBytes(contactPkey),
		signOptical: async (T) => {
			const hex = await $userPQ.signContactChallenge(T);
			if (!hex) throw new Error('Not signed in');
			return hexToBytes(hex);
		},
		signPq: (M) => $userPQ.signHandshakePQ(M),
		signedCard: () => $userPQ.signedOwnCard(),
	};
};

const nameOf = (result) => {
	if (result.card?.name) return result.card.name;
	const known = $userPQ.allNetworkUsers.find((u) => u.user_hash === result.peerHash);
	return known?.name || 'Unknown user';
};

const finished = (id, result) => {
	if (id !== session) return;
	engine = null;
	stopCamera();
	setScanning(false);
	outcome.value = result;
	if (result.kind === 'expired') {
		clearCode();
		stage.value = 'idle';
		return;
	}
	// The last code stays on screen: the counterpart may still be reading it.
	stage.value = 'done';
	if ('vibrate' in navigator) navigator.vibrate(result.kind === 'confirmed' ? [200, 80, 200] : [500]);
	emit('completed', {
		user_hash: result.peerHash,
		contact_pkey: toBase64(result.peerContactPkey),
		confirmed: result.kind === 'confirmed',
		card: result.kind === 'confirmed' ? result.card : null,
		sas: result.sas,
		name: nameOf(result),
		cause: result.kind === 'confirmed' ? null : result.cause,
	});
};

const startSession = async () => {
	const id = ++session;
	engine?.stop();
	engine = null;
	outcome.value = null;
	cameraError.value = null;
	stage.value = 'idle';
	lastScan = { text: '', at: 0 };
	clearCode();

	let me;
	try {
		me = identity();
	} catch (e) {
		cameraError.value = e.message;
		return;
	}
	const current = new HandshakeEngine({
		identity: me,
		// One connection per session, created now: the relay credentials are
		// what is cached, or what arrives within 1 s; none is a session too.
		channel: () => new QwbpChannel({ iceServers: relayIceServers(), log }),
		onShow: (code, s) => {
			if (id !== session) return;
			stage.value = s;
			draw(code, s);
		},
		onLog: log,
		onVerified: () => {
			if (id === session && 'vibrate' in navigator) navigator.vibrate([50]);
		},
		onReadingDone: () => {
			// Nothing is left to read while the channel opens and the ML-DSA work runs.
			if (id === session) stopCamera();
		},
		onDone: (result) => finished(id, result),
	});
	engine = current;
	setScanning(true);
	current.start();

	await nextTick();
	if (id !== session) return;
	try {
		await qrScanner?.start();
	} catch (e) {
		if (id !== session) return;
		log(`camera did not start: ${e?.message ?? e}`);
		cameraError.value = 'The camera did not start. Allow it, or check that no other app uses it.';
		current.stop();
		engine = null;
		setScanning(false);
		return;
	}
};

/** Ends the session: its codes verify against nothing from now on. */
const stopScan = () => {
	session++;
	engine?.stop();
	engine = null;
	stopCamera();
	stage.value = 'idle';
	outcome.value = null;
	clearCode();
	setScanning(false);
};

const toggleScanner = async () => {
	if (scanning.value) {
		stopScan();
		return;
	}
	await startSession();
};

defineExpose({ toggleScanner, stopScan });
</script>

<style lang="scss">
._qrh {
	display: flex;
	flex-direction: column;
	align-items: center;
	max-height: 100dvh;

	._qrh_wrapper {
		width: min(100%, 480px);
		aspect-ratio: 1;
		margin-bottom: 0.75rem;
		border-radius: 0.5rem;
		background: #fff;

		&._hidden {
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

	._qrh_scanner {
		width: 4.5rem;
		aspect-ratio: 1;
		border-radius: 50%;
		overflow: hidden;
		margin-bottom: 0.5rem;

		&._hidden {
			position: absolute;
			top: -9999px;
			opacity: 0;
		}

		video {
			width: 100%;
			height: 100%;
			object-fit: cover;
			transform: scaleX(-1);
		}
	}
}
</style>
