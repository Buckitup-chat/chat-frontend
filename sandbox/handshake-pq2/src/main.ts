// The sandbox page: identity, settings, camera and QR display around the
// engine. Everything runs in this browser; the only traffic is WebRTC
// between the two phones (and STUN, when turned on).
import './style.css';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { HandshakeEngine, type Outcome, type Stage, type Timings } from './engine';
import { PUBLIC_STUN, QwbpChannel } from './channel';
import { createIdentity, deserialize, loadOrCreate, serialize, type Identity } from './identity';
import type { UserCardRow } from '@/lib/data/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const withCamera = !params.has('nocamera');

interface Settings {
	ice: 'none' | 'stun';
	camera: 'user' | 'environment';
	mode: 'honest' | 'impostor';
}
const SETTINGS_KEY = 'pq2.settings';
const IDENTITY_KEY = 'pq2.identity';
const LAST_PEER_KEY = 'pq2.lastPeerCard';
const STAND_IN_KEY = 'pq2.standIn';

const settings: Settings = { ice: 'none', camera: 'user', mode: 'honest', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
const randomName = () => `Phone ${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
let identity: Identity = loadOrCreate(localStorage, IDENTITY_KEY, randomName);

let engine: HandshakeEngine | null = null;
let scanner: QrScanner | null = null;
let currentCode = '';
let lastOutcome: Outcome | null = null;
let sessionStart = 0;
let lastScan = { text: '', at: 0 };
let wakeLock: { release(): Promise<void> } | null = null;

// ---------- the parts of the page ----------

const stageText: Record<Stage, string> = {
	idle: '',
	A: 'Hold the phones face to face. Showing my identity (A).',
	B: 'Read their identity. Showing my signature (B).',
	C: 'Their key is proved in person. Showing my channel offer (C).',
	D: 'Showing my channel answer (D).',
	done: '',
};

const log = (line: string) => {
	const li = document.createElement('li');
	const t = sessionStart ? ((Date.now() - sessionStart) / 1000).toFixed(2) : '—';
	li.textContent = `${t}s  ${line}`;
	$('log').prepend(li);
	console.log('[pq2]', line);
};

const show = async (code: string, stage: Stage) => {
	currentCode = code;
	$('qrWrap').dataset.stage = stage;
	$('stage').textContent = stageText[stage];
	await QRCode.toCanvas($<HTMLCanvasElement>('qr'), code, { errorCorrectionLevel: 'L', margin: 2, width: 720 });
	navigator.vibrate?.(40);
};

const renderWho = () => {
	const mode = settings.mode === 'impostor' ? ' · IMPOSTOR' : '';
	const ice = settings.ice === 'stun' ? 'STUN on' : 'STUN off';
	$('who').textContent = `${identity.name} · ${identity.userHash.slice(0, 12)}… · ${ice}${mode}`;
};

const renderResult = (outcome: Outcome, timings: Timings) => {
	const box = $('result');
	box.hidden = false;
	box.className = outcome.kind;
	$('qrWrap').dataset.outcome = outcome.kind;
	const code = 'code' in outcome && outcome.code ? `<div class="code">${outcome.code}</div><div class="detail">Compare: the other phone must show the same six digits.</div>` : '';
	if (outcome.kind === 'confirmed') {
		box.innerHTML = `<div class="headline">✅ Confirmed: ${escapeHtml(outcome.peerName)}</div>${code}<div class="detail">${outcome.peerHash.slice(0, 16)}…<br>card valid · key certified · post-quantum signature ok</div>`;
	} else if (outcome.kind === 'verified') {
		box.innerHTML = `<div class="headline">🟡 Key verified in person, not confirmed</div>${code}<div class="detail">${escapeHtml(outcome.reason)}<br>${outcome.peerHash.slice(0, 16)}…</div>`;
	} else {
		box.innerHTML = `<div class="headline">⌛ Session expired</div><div class="detail">${escapeHtml(outcome.reason)}</div>`;
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- camera ----------

const startCamera = async () => {
	const video = $<HTMLVideoElement>('video');
	video.dataset.camera = settings.camera;
	if (!withCamera) {
		video.hidden = true;
		return;
	}
	video.hidden = false;
	if (!scanner) {
		scanner = new QrScanner(video, (result) => onScan(result.data), {
			returnDetailedScanResult: true,
			preferredCamera: settings.camera,
			maxScansPerSecond: 12,
			calculateScanRegion: (v) => {
				const size = Math.round(Math.min(v.videoWidth, v.videoHeight) * 0.95);
				const scaled = Math.min(size, 1080);
				return { x: Math.round((v.videoWidth - size) / 2), y: Math.round((v.videoHeight - size) / 2), width: size, height: size, downScaledWidth: scaled, downScaledHeight: scaled };
			},
		});
	} else {
		await scanner.setCamera(settings.camera);
	}
	try {
		await scanner.start();
	} catch (e) {
		log(`camera did not start: ${(e as Error).message ?? e}`);
	}
};

const stopCamera = () => scanner?.stop();

const onScan = (text: string) => {
	const now = Date.now();
	if (text === lastScan.text && now - lastScan.at < 400) return;
	lastScan = { text, at: now };
	void engine?.read(text);
};

// ---------- a session ----------

/** Impostor mode shows the last identity this phone confirmed — as someone who met the victim before — or a stand-in. */
const impostorClaim = (): { userHash: string; card: UserCardRow } => {
	const met = localStorage.getItem(LAST_PEER_KEY);
	if (met) {
		const card = JSON.parse(met) as UserCardRow;
		if (card.user_hash !== identity.userHash) return { userHash: card.user_hash, card };
	}
	const standIn = loadOrCreate(localStorage, STAND_IN_KEY, () => 'Someone else');
	return { userHash: standIn.userHash, card: standIn.card };
};

const startSession = async () => {
	engine?.stop();
	lastOutcome = null;
	$('result').hidden = true;
	$('timingsBox').hidden = true;
	delete $('qrWrap').dataset.outcome;
	$('log').innerHTML = '';
	sessionStart = Date.now();
	renderWho();
	const iceServers = settings.ice === 'stun' ? PUBLIC_STUN : [];
	engine = new HandshakeEngine({
		identity,
		channel: () => new QwbpChannel(iceServers, log),
		claim: settings.mode === 'impostor' ? impostorClaim() : undefined,
		onShow: (code, stage) => void show(code, stage),
		onLog: log,
		onReadingDone: stopCamera,
		onDone: (outcome, timings) => {
			lastOutcome = outcome;
			stopCamera();
			renderResult(outcome, timings);
			navigator.vibrate?.(outcome.kind === 'confirmed' ? [200, 80, 200] : [500]);
			if (outcome.kind === 'confirmed' && settings.mode === 'honest') localStorage.setItem(LAST_PEER_KEY, JSON.stringify(outcome.card));
		},
	});
	engine.start();
	await startCamera();
	await keepScreenOn();
};

const keepScreenOn = async () => {
	try {
		wakeLock ??= await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
	} catch {
		/* not supported, or the page is hidden */
	}
};
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') {
		wakeLock = null;
		void keepScreenOn();
	}
});

// ---------- settings ----------

const fillSettings = () => {
	$<HTMLInputElement>('name').value = identity.name;
	$<HTMLSelectElement>('ice').value = settings.ice;
	$<HTMLSelectElement>('camera').value = settings.camera;
	$<HTMLSelectElement>('mode').value = settings.mode;
	const met = localStorage.getItem(LAST_PEER_KEY);
	$('impostorHint').textContent = met
		? `Impostor mode shows ${(JSON.parse(met) as UserCardRow).name}'s identity (the last one this phone confirmed) with this phone's own key, and sends that card. The other phone must end "not confirmed".`
		: 'Impostor mode shows another identity with this phone\'s own key. Confirm someone first to impersonate them; until then a stand-in identity is used.';
};

$('settingsBtn').addEventListener('click', () => {
	fillSettings();
	$('settings').hidden = !$('settings').hidden;
});

$('applySettings').addEventListener('click', () => {
	settings.ice = $<HTMLSelectElement>('ice').value as Settings['ice'];
	settings.camera = $<HTMLSelectElement>('camera').value as Settings['camera'];
	settings.mode = $<HTMLSelectElement>('mode').value as Settings['mode'];
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	const name = $<HTMLInputElement>('name').value.trim();
	if (name && name !== identity.name) replaceIdentity(name);
	$('settings').hidden = true;
	void startSession();
});

$('newIdentity').addEventListener('click', () => {
	replaceIdentity($<HTMLInputElement>('name').value.trim() || randomName());
	fillSettings();
	void startSession();
});

const replaceIdentity = (name: string) => {
	identity = createIdentity(name);
	localStorage.setItem(IDENTITY_KEY, serialize(identity));
};

// ---------- buttons ----------

$('restart').addEventListener('click', () => void startSession());
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
		userHash: () => identity.userHash,
		useIdentity: (raw: string) => { identity = deserialize(raw); localStorage.setItem(IDENTITY_KEY, raw); },
	},
});

void startSession();
