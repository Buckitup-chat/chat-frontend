<template>
	<div class="_qrh">
		<div class="_qrh_panels">
			<div class="_qrh_code" v-show="shown" :class="{ _hidden: !shown }" :data-stage="stage" :data-outcome="outcome?.kind">
				<div class="_qrh_container">
					<canvas ref="qrCodeRef"></canvas>
				</div>
				<div class="_qrh_caption">Your code · {{ myName }}</div>
				<div class="_qrh_caption _muted" v-if="scanning && hint">{{ hint }}</div>
			</div>
			<!-- Off screen rather than display: none while idle: qr-scanner keeps its video element. -->
			<div class="_qrh_camera" :class="{ _hidden: !scanning }">
				<video ref="qrScannerRef" muted playsinline></video>
				<div class="_qrh_overlay" v-if="cameraStarting">Starting the camera…</div>
				<div class="_qrh_caption _on_dark">{{ computer ? "Webcam · show the other phone's code" : 'Point at the code on the other phone' }}</div>
			</div>
		</div>

		<div class="_qrh_tip" v-if="scanning">
			<span class="_qrh_art"><i class="_icon_qr_handshake"></i></span>
			<div class="ui-small">
				<template v-if="computer">
					On a computer: let the other person scan your code with their phone, then hold their phone up to your camera, 25–40 cm away.
				</template>
				<template v-else>
					Hold the phones screen to screen, 25–40 cm apart: closer, the front cameras do not focus. Each one reads the other's code.
				</template>
			</div>
		</div>

		<div class="ui-card _qrh_state" v-if="outcome?.kind === 'expired'">
			<div>Session expired</div>
			<div class="ui-small ui-secondary">Start again to make new codes.</div>
			<button type="button" class="ui-btn _outline _block" @click="startSession()">Start again</button>
		</div>
		<div class="ui-card _qrh_state" v-if="outcome?.kind === 'failed'">
			<div class="_danger">Your code could not be made</div>
			<div class="ui-small ui-secondary">This phone could not sign its code. Sign in again, then start again.</div>
		</div>
		<div class="ui-card _qrh_state" v-if="cameraError">
			<div>{{ cameraError.title }}</div>
			<div class="ui-small ui-secondary">{{ cameraError.text }}</div>
			<button type="button" class="ui-btn _outline _block" @click="startSession()">Try again</button>
		</div>
	</div>
</template>

<script setup>
// The optical handshake v2 (docs/task-handshake-pq2.md): the camera and the
// QR code on screen; the result goes to the modal, which shows it. The
// protocol is the engine's
// (src/lib/handshake/engine.ts) and the module's (packages/pq-client/src/handshake.ts);
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
import { toBase64, toBytes } from '@buckitup/pq-client/signature';
import { describeThisDevice } from '@/lib/thisDevice';

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
const cameraStarting = ref(false);
const shown = computed(() => scanning.value || !!outcome.value);
const myName = computed(() => $userPQ.currentUser?.name || 'you');
// A computer holds its webcam up to the phone, not screen to screen.
const device = describeThisDevice();
const computer = device.kind === 'computer';

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
	// The scanner the PQ1 handshake used, which read these codes well on phones:
	// qr-scanner's default scan rate, and a square region of 95% of the frame
	// read at full resolution. qr-scanner's bundled decoder at 1080 px, 12 scans
	// a second, read worse on the phones it was tried on. The region is whole
	// pixels: qr-scanner reuses its canvas only while the size is unchanged.
	// The decoder is the browser's BarcodeDetector on Android, where it read
	// well, and qr-scanner's own elsewhere: Chrome on a Mac has a
	// BarcodeDetector too, and it did not read a phone's code that the bundled
	// decoder (what Brave, Firefox and Safari get) read from the same camera.
	qrScanner = new QrScanner(qrScannerRef.value, (result) => onScan(result.data), {
		returnDetailedScanResult: true,
		qrEngine: device.name === 'Android' ? undefined : import('qr-scanner/qr-scanner-worker.min.js').then((m) => m.createWorker()),
		preferredCamera: 'user',
		highlightScanRegion: true,
		highlightCodeOutline: true,
		calculateScanRegion: (video) => {
			const size = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.95);
			return { x: Math.round((video.videoWidth - size) / 2), y: Math.round((video.videoHeight - size) / 2), width: size, height: size };
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
		margin: 0,
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
	if (result.kind === 'expired' || result.kind === 'failed') {
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

// The camera starts first: the 90 s session, its nonce and its connection
// begin once it runs, so a permission prompt takes nothing out of them.
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
		cameraError.value = { title: 'No account to add a contact to', text: e.message };
		return;
	}
	setScanning(true);
	await nextTick();
	if (id !== session) return;
	cameraStarting.value = true;
	try {
		await qrScanner?.start();
	} catch (e) {
		if (id !== session) return;
		cameraStarting.value = false;
		log(`camera did not start: ${e?.message ?? e}`);
		cameraError.value = {
			title: "BuckitUp can't use the camera",
			text: 'The camera did not start. Allow camera access in the browser settings, or check that no other app uses it.',
		};
		setScanning(false);
		return;
	}
	if (id === session) cameraStarting.value = false;
	if (id !== session) {
		// Stopped while the camera was starting: nothing scans now, so the camera
		// this start turned on goes off. Replaced by a newer session instead: the
		// camera is that session's, and stays.
		if (!scanning.value) stopCamera();
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
	current.start();
};

/** Ends the session: its codes verify against nothing from now on. */
const stopScan = () => {
	session++;
	cameraStarting.value = false;
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
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._qrh {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);

	._qrh_panels {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-4);

		@include media-breakpoint-up(md) {
			flex-direction: row;
			align-items: stretch;
		}
	}

	._qrh_code {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		width: min(100%, 220px);

		@include media-breakpoint-up(md) {
			flex: 1;
			width: auto;
			padding: var(--space-5);
			border-radius: var(--radius-card);
			background: var(--color-surface);
		}

		&._hidden { display: none; }
	}

	._qrh_container {
		width: 100%;
		max-width: 260px;
		aspect-ratio: 1;
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: #fff;

		canvas {
			width: 100% !important;
			height: 100% !important;
		}
	}

	._qrh_caption {
		font-size: var(--text-sm);
		line-height: var(--leading-sm);
		color: var(--color-text-secondary);
		text-align: center;

		&._muted { color: var(--color-text-muted); font-size: var(--text-xs); }
		&._on_dark {
			position: absolute;
			left: 0;
			right: 0;
			bottom: var(--space-4);
			color: #fff;
		}
	}

	._qrh_camera {
		position: relative;
		width: 100%;
		aspect-ratio: 1;
		max-height: 50dvh;
		overflow: hidden;
		border-radius: var(--radius-card);
		background: #1f1a21;

		@include media-breakpoint-up(md) { flex: 1; max-height: none; }

		&._hidden {
			position: absolute;
			top: -9999px;
			opacity: 0;
		}

		video {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
	}

	._qrh_overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		font-size: var(--text-sm);
	}

	._qrh_tip {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-card);
		background: var(--color-surface);
		color: var(--color-text-secondary);
	}

	._qrh_art {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 56px;
		height: 56px;
		border-radius: var(--radius-input);
		background: var(--color-bg);

		i { width: 28px; height: 28px; background-color: var(--color-accent); }
	}

	._qrh_state {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4);

		._danger { color: var(--color-danger); }
		.ui-btn { margin-top: var(--space-2); }
	}
}
</style>
