// The sandbox page: identity, settings, camera and QR display around the
// engine. Everything runs in this browser; the only traffic is WebRTC
// between the two phones (and STUN, when turned on).
import './style.css';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { DEFAULT_ICE_SERVERS } from 'qwbp';
import escapeHtml from '@/utils/escapeHtml';
import { HandshakeEngine, type Outcome, type Stage, type Timings } from './engine';
import { QwbpChannel } from './channel';
import { createIdentity, type Identity } from './identity';
import { FRAME_DATA_CHARS, FRAME_PREFIX, type FrameSize } from './frames';
import { PREFIX } from './protocol';
import type { UserCardRow } from '@/lib/data/types';
import tutorialUrl from '../../../public/img/handshake_tutorial.svg';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const withCamera = !new URLSearchParams(location.search).has('nocamera');

interface Settings {
	name: string;
	/** none, stun and turn: a WebRTC channel; frames: animated QR, no network. */
	channel: 'none' | 'stun' | 'turn' | 'frames';
	/** The relay server for channel 'turn', as RTCIceServer takes it. */
	turnUrl: string;
	turnUser: string;
	turnPass: string;
	/** Offer only the relay server's addresses, so that a connection goes through it even on one network. */
	relayOnly: boolean;
	frameSize: FrameSize;
	fps: number;
	camera: 'user' | 'environment';
	/** app: as QRScannerEngine.vue — the browser's BarcodeDetector where there is one, qr-scanner's defaults; bundled: qr-scanner's own decoder at up to 1080 px. */
	decoder: 'app' | 'bundled';
	mode: 'honest' | 'impostor';
}
// Only settings and the public card of the last confirmed peer are stored.
// The page is served from an origin other pages share, so the identity and
// its secret keys live in the page only: a reload makes a new one.
const SETTINGS_KEY = 'pq2.settings';
const LAST_PEER_KEY = 'pq2.lastPeerCard';

const stored = <T>(key: string): T | null => {
	try {
		return JSON.parse(localStorage.getItem(key) ?? 'null');
	} catch {
		return null;
	}
};

const randomName = () => `Phone ${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const settings: Settings = {
	name: randomName(),
	channel: 'none',
	frameSize: 'medium',
	fps: 5,
	turnUrl: '',
	turnUser: '',
	turnPass: '',
	relayOnly: true,
	camera: 'user',
	decoder: 'app',
	mode: 'honest',
	...stored<Partial<Settings>>(SETTINGS_KEY),
};
// The relay password stays in the page too: any page on this origin reads localStorage.
const saveSettings = () => {
	const { turnPass: _secret, ...kept } = settings;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(kept));
};
saveSettings(); // the phone keeps its name across reloads
let identity: Identity = createIdentity(settings.name);

let engine: HandshakeEngine | null = null;
let scanner: QrScanner | null = null;
let scannerDecoder: Settings['decoder'] | null = null;
let currentCode = '';
let lastOutcome: Outcome | null = null;
let sessionStart = 0;
let lastScan = { text: '', at: 0 };
/** Codes the camera read this session, so the log names each one once. */
let scanned = new Set<string>();
/** Frames the decoder looked at and found no code in. */
let framesScanned = 0;
let wakeLock: WakeLockSentinel | null = null;

// ---------- the parts of the page ----------

const stageText: Record<Stage, string> = {
	idle: '',
	A: 'Hold the phones face to face. Showing my identity (A).',
	B: 'Read their identity. Showing my signature (B).',
	C: 'Their key is proved in person. Showing my channel offer (C).',
	D: 'Showing my channel answer (D).',
	F: 'Their key is proved in person. Exchanging the proofs as moving frames: hold still.',
	done: '',
};

const log = (line: string) => {
	const li = document.createElement('li');
	const t = sessionStart ? ((Date.now() - sessionStart) / 1000).toFixed(2) : '—';
	li.textContent = `${t}s  ${line}`;
	$('log').prepend(li);
	console.log('[pq2]', line);
};

// The app's colours for the code (QRScannerEngine.vue): black while scanning,
// purple once the other phone is read, dark purple once its key is proved.
const stageColor: Record<Stage, string> = {
	idle: '#000',
	A: '#000',
	B: '#8e2b77',
	C: '#611e52',
	D: '#611e52',
	F: '#611e52',
	done: '#611e52',
};

let shownStage: Stage = 'idle';
const show = async (code: string, stage: Stage) => {
	currentCode = code;
	if (stage !== shownStage) {
		// Frames change several times a second; the text and the buzz follow the steps.
		shownStage = stage;
		$('stage').textContent = stageText[stage];
		navigator.vibrate?.(40);
	}
	await QRCode.toCanvas($<HTMLCanvasElement>('qr'), code, {
		errorCorrectionLevel: 'L',
		margin: 0,
		scale: 4, // a small canvas: CSS scales it up with image-rendering: pixelated, sharp at any size
		color: { dark: stageColor[stage], light: '#ffffff' },
	});
};

const renderWho = () => {
	const mode = settings.mode === 'impostor' ? ' · IMPOSTOR' : '';
	const ice = {
		none: 'STUN off',
		stun: 'STUN on',
		turn: `TURN${settings.relayOnly ? ', relay only' : ''}`,
		frames: `animated QR, ${settings.frameSize}, ${settings.fps}/s`,
	}[settings.channel];
	const name = identity.card.name ?? '';
	$('avatar').textContent = (name.split(/\s+/).pop() ?? '').slice(0, 2).toUpperCase();
	$('who').textContent = name;
	$('whoMeta').textContent = `[${identity.userHash.slice(2, 7)}] · ${ice}${mode}`;
};

// Laid out as the app's "Contact found": a divider, the name and [hash], then the six digits.
const renderResult = (outcome: Outcome, timings: Timings) => {
	const box = $('result');
	box.hidden = false;
	box.className = outcome.kind;
	const code = 'code' in outcome && outcome.code ? `<div class="code">${outcome.code}</div><div class="detail">The other phone must show the same six digits.</div>` : '';
	if (outcome.kind !== 'expired') {
		const [badge, name, detail] = outcome.kind === 'confirmed'
			? ['✅ Confirmed', outcome.peerName, outcome.card ? 'card valid · key certified · post-quantum signature ok' : 'identity key matches · optical and post-quantum signatures ok']
			: ['🟡 Key verified in person, not confirmed', 'Unconfirmed', outcome.reason];
		box.innerHTML = `<div class="divider">Contact found</div><div class="badge">${badge}</div><div class="name"><b>${escapeHtml(name)}</b><span>[${outcome.peerHash.slice(2, 7)}]</span></div>${code}<div class="detail">${escapeHtml(detail)}</div>`;
	} else {
		box.innerHTML = `<div class="badge">⌛ Session expired</div><div class="detail">${escapeHtml(outcome.reason)}</div>`;
	}
	$('stage').textContent = '';
	const list = $('timings');
	list.innerHTML = '';
	for (const [milestone, ms] of Object.entries(timings)) {
		const li = document.createElement('li');
		li.textContent = `${milestone}: ${(ms / 1000).toFixed(2)} s`;
		list.append(li);
	}
	$('timingsBox').hidden = false;
};

const clearResult = () => {
	const box = $('result');
	box.hidden = true;
	box.className = '';
	box.replaceChildren();
	$('timingsBox').hidden = true;
};

// ---------- what the page shows: idle, scanning, done ----------

type View = 'idle' | 'scanning' | 'done';
const setView = (view: View) => {
	// As the app: the header and the introduction while idle, the code and the
	// camera while scanning; the code stays up when done, for a phone still reading it.
	$('head').hidden = view === 'scanning';
	$('intro').hidden = view !== 'idle';
	$('qrWrap').hidden = view === 'idle';
	$('scannerWrap').hidden = view !== 'scanning' || !withCamera;
	$('stage').hidden = view !== 'scanning';
	const start = $('start');
	start.textContent = { idle: 'Start handshake scanning', scanning: 'Scanning... Click to stop', done: 'Scan again' }[view];
	start.className = view === 'done' ? 'btn btn-outline wide' : 'btn btn-dark btn-lg wide';
	if (view === 'scanning') $('settings').hidden = true;
};

// ---------- camera and screen ----------

const startCamera = async () => {
	if (!withCamera) return;
	const video = $<HTMLVideoElement>('video');
	if (scanner && scannerDecoder !== settings.decoder) {
		scanner.destroy();
		scanner = null;
	}
	if (!scanner) {
		// qr-scanner prefers the browser's BarcodeDetector whenever the browser
		// lists QR among its formats, and falls back only when it throws. The app
		// leaves it so. "bundled" turns it off: a browser can list QR and still
		// find nothing, and the decoder qr-scanner ships reads the same everywhere.
		const bundled = settings.decoder === 'bundled';
		(QrScanner as unknown as { _disableBarcodeDetector: boolean })._disableBarcodeDetector = bundled;
		scannerDecoder = settings.decoder;
		scanner = new QrScanner(video, (result) => onScan(result.data), {
			returnDetailedScanResult: true,
			onDecodeError: () => framesScanned++,
			preferredCamera: settings.camera,
			highlightScanRegion: true,
			highlightCodeOutline: true,
			...(bundled ? { maxScansPerSecond: 12 } : {}),
			calculateScanRegion: (v) => {
				const size = Math.round(Math.min(v.videoWidth, v.videoHeight) * 0.95);
				const x = Math.round((v.videoWidth - size) / 2);
				const y = Math.round((v.videoHeight - size) / 2);
				if (!bundled) return { x, y, width: size, height: size };
				const scaled = Math.min(size, 1080);
				return { x, y, width: size, height: size, downScaledWidth: scaled, downScaledHeight: scaled };
			},
		});
	} else {
		await scanner.setCamera(settings.camera);
	}
	try {
		await scanner.start();
	} catch (e) {
		log(`camera did not start: ${(e as Error).message ?? e}`);
		return;
	}
	log(`camera: ${video.videoWidth}×${video.videoHeight}, ${settings.decoder === 'bundled' ? "qr-scanner's bundled decoder" : `as the app (BarcodeDetector ${'BarcodeDetector' in window ? 'present' : 'absent'})`}`);
	// Tells a camera that looks at codes and finds none from one that is not scanning at all.
	const session = sessionStart;
	framesScanned = 0;
	setTimeout(() => {
		if (session === sessionStart && !scanned.size) log(`camera: ${framesScanned} frames scanned in 5 s, no code found`);
	}, 5_000);
};

const stopCamera = () => scanner?.stop();

const onScan = (text: string) => {
	const now = Date.now();
	if (text === lastScan.text && now - lastScan.at < 400) return;
	lastScan = { text, at: now };
	if (!scanned.has(text)) {
		scanned.add(text);
		// Frames are many: the engine reports how far they got.
		if (!text.startsWith(FRAME_PREFIX)) log(`camera read ${text.startsWith(`${PREFIX}:`) ? text.slice(PREFIX.length + 1, PREFIX.length + 2) : 'a code that is not PQ2'} (${text.length} characters)`);
	}
	void engine?.read(text);
};

const keepScreenOn = async () => {
	try {
		wakeLock ??= (await navigator.wakeLock?.request('screen')) ?? null;
	} catch {
		/* not supported, or the page is hidden */
	}
};
const letScreenSleep = () => {
	void wakeLock?.release();
	wakeLock = null;
};
document.addEventListener('visibilitychange', () => {
	// A hidden page loses its lock; a session still running takes it again.
	if (document.visibilityState === 'visible' && engine && !lastOutcome) {
		wakeLock = null;
		void keepScreenOn();
	}
});

// ---------- a session ----------

/** Impostor mode shows the last identity this phone confirmed — as someone who met the victim before — or a stand-in. */
const impostorClaim = (): { userHash: string; card: UserCardRow } => {
	const met = stored<UserCardRow>(LAST_PEER_KEY);
	const card = met && met.user_hash !== identity.userHash ? met : createIdentity('Someone else').card;
	return { userHash: card.user_hash, card };
};

const startSession = async () => {
	engine?.stop();
	lastOutcome = null;
	scanned = new Set();
	clearResult();
	$('log').innerHTML = '';
	sessionStart = Date.now();
	shownStage = 'idle';
	renderWho();
	const iceServers = {
		none: [],
		stun: DEFAULT_ICE_SERVERS,
		turn: [{ urls: settings.turnUrl, username: settings.turnUser, credential: settings.turnPass }],
		frames: [],
	}[settings.channel];
	engine = new HandshakeEngine({
		identity,
		...(settings.channel === 'frames'
			? { frames: { dataChars: FRAME_DATA_CHARS[settings.frameSize], fps: settings.fps } }
			: { channel: () => new QwbpChannel(iceServers, log, settings.channel === 'turn' && settings.relayOnly) }),
		onProgress: ({ sent, peerHas, received, total }) => {
			$('stage').textContent = `Frames: they hold ${peerHas}/${sent} of mine, I hold ${received}/${total} of theirs. Hold still.`;
		},
		claim: settings.mode === 'impostor' ? impostorClaim() : undefined,
		onShow: (code, stage) => void show(code, stage),
		onLog: log,
		onReadingDone: stopCamera,
		onDone: (outcome, timings) => {
			lastOutcome = outcome;
			stopCamera();
			letScreenSleep();
			setView('done');
			renderResult(outcome, timings);
			navigator.vibrate?.(outcome.kind === 'confirmed' ? [200, 80, 200] : [500]);
			if (outcome.kind === 'confirmed' && outcome.card && settings.mode === 'honest') localStorage.setItem(LAST_PEER_KEY, JSON.stringify(outcome.card));
		},
	});
	setView('scanning');
	engine.start();
	await startCamera();
	await keepScreenOn();
};

const stopSession = () => {
	engine?.stop();
	engine = null;
	stopCamera();
	letScreenSleep();
	clearResult();
	setView('idle');
};

// ---------- settings ----------

const fillSettings = () => {
	$<HTMLInputElement>('name').value = settings.name;
	$<HTMLSelectElement>('channel').value = settings.channel;
	$<HTMLInputElement>('turnUrl').value = settings.turnUrl;
	$<HTMLInputElement>('turnUser').value = settings.turnUser;
	$<HTMLInputElement>('turnPass').value = settings.turnPass;
	$<HTMLInputElement>('relayOnly').checked = settings.relayOnly;
	$<HTMLSelectElement>('frameSize').value = settings.frameSize;
	$<HTMLSelectElement>('fps').value = String(settings.fps);
	$<HTMLSelectElement>('camera').value = settings.camera;
	$<HTMLSelectElement>('decoder').value = settings.decoder;
	$<HTMLSelectElement>('mode').value = settings.mode;
	const met = stored<UserCardRow>(LAST_PEER_KEY);
	$('impostorHint').textContent = met
		? `Impostor mode shows ${met.name}'s identity (the last one this phone confirmed) with this phone's own key, and sends that card. The other phone must end "not confirmed".`
		: 'Impostor mode shows another identity with this phone\'s own key. Confirm someone first to impersonate them; until then a stand-in identity is used.';
};

$('settingsBtn').addEventListener('click', () => {
	fillSettings();
	$('settings').hidden = !$('settings').hidden;
});

$('applySettings').addEventListener('click', () => {
	settings.channel = $<HTMLSelectElement>('channel').value as Settings['channel'];
	settings.turnUrl = $<HTMLInputElement>('turnUrl').value.trim();
	settings.turnUser = $<HTMLInputElement>('turnUser').value.trim();
	settings.turnPass = $<HTMLInputElement>('turnPass').value;
	settings.relayOnly = $<HTMLInputElement>('relayOnly').checked;
	settings.frameSize = $<HTMLSelectElement>('frameSize').value as FrameSize;
	settings.fps = Number($<HTMLSelectElement>('fps').value);
	settings.camera = $<HTMLSelectElement>('camera').value as Settings['camera'];
	settings.decoder = $<HTMLSelectElement>('decoder').value as Settings['decoder'];
	settings.mode = $<HTMLSelectElement>('mode').value as Settings['mode'];
	const name = $<HTMLInputElement>('name').value.trim();
	if (name && name !== settings.name) {
		settings.name = name;
		identity = createIdentity(name); // the name is in the signed card
	}
	saveSettings();
	$('settings').hidden = true;
	renderWho();
});

$('newIdentity').addEventListener('click', () => {
	identity = createIdentity(settings.name);
	renderWho();
});

// ---------- buttons ----------

// One button, as the app's: start, stop while scanning, scan again when done.
$('start').addEventListener('click', () => {
	if (engine && !lastOutcome) stopSession();
	else void startSession();
});
$('manual').addEventListener('click', () => {
	const text = prompt('Paste the other phone\'s current code');
	if (text) void engine?.read(text);
});
$('copy').addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(currentCode);
		log('my code copied');
	} catch {
		prompt('My current code', currentCode);
	}
});

// For the automated check (scripts/check.mjs): read and feed codes without a camera.
Object.assign(window, {
	__pq2: {
		code: () => currentCode,
		read: (text: string) => engine?.read(text),
		outcome: () => lastOutcome,
		stage: () => engine?.currentStage,
	},
});

$<HTMLImageElement>('tutorial').src = tutorialUrl;
renderWho();
setView('idle');
