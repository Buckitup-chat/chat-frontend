// WebAuthn PRF probe: does a passkey on this device (or on a phone over
// hybrid) evaluate the PRF extension, and is the output stable?
//
// No server: challenges are random and nothing is verified, as nothing is
// signed in. The page never shows or stores a PRF output — only the first
// 8 hex characters of its SHA-256, enough to tell outputs apart. It keeps
// the last credential's id and creation time in localStorage, nothing else.
/* global BufferSource, PublicKeyCredentialRequestOptions -- DOM types, which ESLint's globals list lacks */
import './style.css';

const RP_NAME = 'BuckitUp PRF probe';
const SALT1_LABEL = 'buckitup/prf-probe/v1';
const SALT2_LABEL = 'buckitup/prf-probe/v1/second';
const STORE_KEY = 'prfProbe.credential';
const TIMEOUT_MS = 120_000;
const ENV_PROBE_MS = 5_000;

type StepName = 'create' | 'get-this' | 'get-any' | 'get-hybrid';
type ErrorInfo = { name: string; message: string };

interface StepResult {
	step: StepName;
	at: string;
	ms: number;
	ok: boolean;
	credentialId?: string;
	authenticatorAttachment?: string | null;
	error?: ErrorInfo;
	// create
	transports?: string[] | null;
	publicKeyAlg?: number | null;
	prfEnabled?: boolean | null;
	prfFirstAtCreate?: string | null;
	// get
	sameAsStored?: boolean | null;
	prfReturned?: boolean;
	prfFirst?: string | null;
	prfSecond?: string | null;
	prfLength?: number | null;
}

interface Summary {
	verdict: string;
	prfEnabledAtCreate: boolean | null;
	prfOutputAtCreate: boolean | null;
	prfOutputAtGet: boolean | null;
	prfViaHybrid: boolean | null;
	deterministic: boolean | null;
	firstDiffersFromSecond: boolean | null;
	createMatchesGet: boolean | null;
}

interface StoredCredential {
	id: string;
	createdAt: string;
}

// navigator.userAgentData is Chromium-only and not in lib.dom.
interface UADataLike {
	mobile?: boolean;
	platform?: string;
	getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const environment: Record<string, unknown> = {};
const steps: StepResult[] = [];
let salts: { first: Uint8Array; second: Uint8Array } | null = null;

// ---------------------------------------------------------------- bytes

const enc = new TextEncoder();

function toBytes(src: BufferSource): Uint8Array {
	return src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

function b64url(src: BufferSource): string {
	let s = '';
	for (const b of toBytes(src)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function random(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

async function sha256(data: BufferSource): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** First 8 hex characters of SHA-256(output). The output itself is wiped and never shown. */
async function fingerprint(output: BufferSource): Promise<{ fp: string; length: number }> {
	const bytes = toBytes(output);
	const digest = await sha256(bytes);
	const length = bytes.length;
	bytes.fill(0);
	return { fp: Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(''), length };
}

async function getSalts() {
	salts ??= { first: await sha256(enc.encode(SALT1_LABEL)), second: await sha256(enc.encode(SALT2_LABEL)) };
	return salts;
}

// ---------------------------------------------------------------- errors, log

function errorInfo(e: unknown): ErrorInfo {
	if (e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException)) {
		return { name: (e as Error).name, message: (e as Error).message };
	}
	return { name: 'Error', message: String(e) };
}

function stamp(d = new Date()): string {
	return d.toISOString().slice(11, 23);
}

function log(text: string, kind: '' | 'ok' | 'error' = '') {
	const li = document.createElement('li');
	li.textContent = `${stamp()} ${text}`;
	if (kind) li.className = kind;
	$('log').prepend(li);
}

// ---------------------------------------------------------------- storage

function loadStored(): StoredCredential | null {
	try {
		const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
		return v && typeof v.id === 'string' ? { id: v.id, createdAt: String(v.createdAt ?? '') } : null;
	} catch {
		return null;
	}
}

function saveStored(id: string) {
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify({ id, createdAt: new Date().toISOString() }));
	} catch (e) {
		log(`could not store the passkey id: ${errorInfo(e).message}`, 'error');
	}
}

function renderStored() {
	const s = loadStored();
	$('stored').textContent = s
		? `Stored passkey: ${s.id.slice(0, 16)}… (created ${s.createdAt.replace('T', ' ').slice(0, 19)} UTC)`
		: 'No passkey stored yet: run step 1 first.';
}

// ---------------------------------------------------------------- environment

/** A probe's value, 'unsupported' if the API is missing, or the error it threw. */
async function probe<T>(fn: (() => Promise<T>) | undefined): Promise<T | 'unsupported' | { error: ErrorInfo }> {
	if (!fn) return 'unsupported';
	try {
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new DOMException(`no answer in ${ENV_PROBE_MS} ms`, 'TimeoutError')), ENV_PROBE_MS),
		);
		return await Promise.race([fn(), timeout]);
	} catch (e) {
		return { error: errorInfo(e) };
	}
}

async function collectEnvironment() {
	environment.userAgent = navigator.userAgent;
	environment.platform = navigator.platform;
	environment.secureContext = window.isSecureContext;
	environment.origin = location.origin;
	environment.rpId = location.hostname;

	const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
	if (uaData) {
		const high = await probe(uaData.getHighEntropyValues ? () => uaData.getHighEntropyValues!(['platformVersion', 'model', 'fullVersionList']) : undefined);
		const h = high && typeof high === 'object' && !('error' in high) ? high : {};
		const brands = Array.isArray(h.fullVersionList) ? (h.fullVersionList as { brand: string; version: string }[]) : [];
		environment.userAgentData = {
			platform: uaData.platform,
			platformVersion: h.platformVersion,
			model: h.model || undefined,
			mobile: uaData.mobile,
			browsers: brands.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`),
		};
	}

	const PKC = typeof PublicKeyCredential === 'undefined' ? undefined : PublicKeyCredential;
	environment.webauthn = !!PKC;
	environment.userVerifyingPlatformAuthenticator = await probe(
		PKC?.isUserVerifyingPlatformAuthenticatorAvailable ? () => PKC.isUserVerifyingPlatformAuthenticatorAvailable() : undefined,
	);
	environment.conditionalMediation = await probe(
		PKC && 'isConditionalMediationAvailable' in PKC ? () => PKC.isConditionalMediationAvailable() : undefined,
	);
	const caps = await probe(PKC && 'getClientCapabilities' in PKC ? () => PKC.getClientCapabilities() : undefined);
	environment.clientCapabilities = caps;
	environment.prfCapability =
		caps && typeof caps === 'object' && !('error' in caps) && 'extension:prf' in caps ? (caps as Record<string, unknown>)['extension:prf'] : null;
}

function show(value: unknown): string {
	if (value === undefined || value === null) return '—';
	if (typeof value === 'string') return value;
	// An object (client capabilities): one key per line.
	if (typeof value === 'object' && !Array.isArray(value)) {
		return Object.entries(value).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
	}
	return JSON.stringify(value);
}

function renderKv(dl: HTMLElement, rows: [string, unknown][]) {
	dl.replaceChildren();
	for (const [k, v] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = show(v);
		if (v === true) dd.className = 'yes';
		else if (v === false) dd.className = 'no';
		else if (v === null) dd.className = 'unknown';
		dl.append(dt, dd);
	}
}

function renderEnvironment() {
	const e = environment;
	const ua = e.userAgentData as Record<string, unknown> | undefined;
	renderKv($('env'), [
		['Origin', e.origin],
		['Secure context', e.secureContext],
		['WebAuthn', e.webauthn],
		['Platform authenticator (UV)', e.userVerifyingPlatformAuthenticator],
		['Conditional mediation', e.conditionalMediation],
		['extension:prf', e.prfCapability],
		['Client capabilities', e.clientCapabilities],
		['Platform', ua ? `${ua.platform} ${ua.platformVersion ?? ''}${ua.model ? ` (${ua.model})` : ''}`.trim() : e.platform],
		...(ua ? [['Browser', (ua.browsers as string[]).join(', ')] as [string, unknown]] : []),
		['User agent', e.userAgent],
	]);
}

// ---------------------------------------------------------------- summary, report

function summarize(): Summary {
	const creates = steps.filter((s) => s.step === 'create' && s.ok);
	const gets = steps.filter((s) => s.step !== 'create' && s.ok);
	// The hybrid step's sheet also offers this device's own passkeys; one
	// picked there (attachment "platform") is a local get, not a phone's.
	const viaHybrid = (s: StepResult) => s.step === 'get-hybrid' && s.authenticatorAttachment !== 'platform';
	const localGets = gets.filter((s) => !viaHybrid(s));
	const hybridGets = gets.filter(viaHybrid);
	const lastCreate = creates.at(-1);

	// Every salt1 fingerprint per credential, from creates and gets.
	const byCredential = new Map<string, string[]>();
	for (const s of [...creates, ...gets]) {
		const fp = s.step === 'create' ? s.prfFirstAtCreate : s.prfFirst;
		if (!fp || !s.credentialId) continue;
		byCredential.set(s.credentialId, [...(byCredential.get(s.credentialId) ?? []), fp]);
	}
	const getFps = new Map<string, string[]>();
	for (const s of gets) {
		if (s.prfFirst && s.credentialId) getFps.set(s.credentialId, [...(getFps.get(s.credentialId) ?? []), s.prfFirst]);
	}
	const repeated = [...getFps.values()].filter((fps) => fps.length >= 2);
	const pairs = gets.filter((s) => s.prfFirst && s.prfSecond);
	const createVsGet = creates.filter((c) => c.prfFirstAtCreate && getFps.has(c.credentialId!));

	const anyOutput = (list: StepResult[]) => (list.length ? list.some((s) => s.prfReturned) : null);
	const summary: Summary = {
		verdict: '',
		prfEnabledAtCreate: lastCreate ? (lastCreate.prfEnabled ?? null) : null,
		prfOutputAtCreate: lastCreate ? !!lastCreate.prfFirstAtCreate : null,
		prfOutputAtGet: anyOutput(localGets),
		prfViaHybrid: anyOutput(hybridGets),
		deterministic: repeated.length ? repeated.every((fps) => fps.every((fp) => fp === fps[0])) : null,
		firstDiffersFromSecond: pairs.length ? pairs.every((s) => s.prfFirst !== s.prfSecond) : null,
		createMatchesGet: createVsGet.length
			? createVsGet.every((c) => getFps.get(c.credentialId!)!.every((fp) => fp === c.prfFirstAtCreate))
			: null,
	};

	const anyPrf = summary.prfOutputAtGet || summary.prfViaHybrid || summary.prfOutputAtCreate;
	if (anyPrf) {
		const broken = summary.deterministic === false || summary.firstDiffersFromSecond === false || summary.createMatchesGet === false;
		summary.verdict = broken ? 'PRF answers, but the outputs are inconsistent' : summary.deterministic ? 'PRF works' : 'PRF works (run step 2 again to confirm it is stable)';
	} else if (summary.prfEnabledAtCreate === false || summary.prfOutputAtGet === false || summary.prfViaHybrid === false) {
		summary.verdict = 'no PRF';
	} else if (steps.length) {
		summary.verdict = 'not known yet (see the errors in the log)';
	} else {
		summary.verdict = 'not tested yet';
	}
	return summary;
}

function buildReport() {
	return {
		probe: SALT1_LABEL,
		generatedAt: new Date().toISOString(),
		environment,
		summary: summarize(),
		steps,
	};
}

function render() {
	const report = buildReport();
	const s = report.summary;
	renderKv($('summary'), [
		['Verdict', s.verdict],
		['PRF enabled at create', s.prfEnabledAtCreate],
		['PRF output at create', s.prfOutputAtCreate],
		['PRF output at get', s.prfOutputAtGet],
		['PRF via phone (hybrid)', s.prfViaHybrid],
		['Same output every get', s.deterministic],
		['first ≠ second', s.firstDiffersFromSecond],
		['Create output = get output', s.createMatchesGet],
	]);
	$('report').textContent = JSON.stringify(report, null, 2);
	renderStored();
}

// ---------------------------------------------------------------- steps

function yesNo(v: boolean | null | undefined) {
	return v === true ? 'yes' : v === false ? 'no' : 'not reported';
}

async function prfOutputs(cred: PublicKeyCredential) {
	const prf = cred.getClientExtensionResults().prf;
	const first = prf?.results?.first ? await fingerprint(prf.results.first) : null;
	const second = prf?.results?.second ? await fingerprint(prf.results.second) : null;
	return { prf, first, second };
}

async function create(): Promise<Partial<StepResult>> {
	const { first } = await getSalts();
	const userId = random(16); // random, not a secret: the vault must not live here
	const name = `prf-probe-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
	const cred = (await navigator.credentials.create({
		publicKey: {
			rp: { id: location.hostname, name: RP_NAME },
			user: { id: userId, name, displayName: `PRF probe ${name.slice(10)}` },
			challenge: random(32),
			pubKeyCredParams: [
				{ type: 'public-key', alg: -7 }, // ES256
				{ type: 'public-key', alg: -8 }, // EdDSA
				{ type: 'public-key', alg: -257 }, // RS256
			],
			authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
			attestation: 'none',
			timeout: TIMEOUT_MS,
			extensions: { prf: { eval: { first } } },
		},
	})) as PublicKeyCredential | null;
	if (!cred) throw new DOMException('the browser returned no credential', 'UnknownError');

	const response = cred.response as AuthenticatorAttestationResponse;
	const { prf, first: out } = await prfOutputs(cred);
	const id = b64url(cred.rawId);
	saveStored(id);
	const result: Partial<StepResult> = {
		credentialId: id,
		authenticatorAttachment: cred.authenticatorAttachment ?? null,
		transports: typeof response.getTransports === 'function' ? response.getTransports() : null,
		publicKeyAlg: typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : null,
		prfEnabled: prf ? (prf.enabled ?? null) : null,
		prfFirstAtCreate: out?.fp ?? null,
	};
	log(
		`create: PRF enabled ${yesNo(result.prfEnabled)}, output at create ${out ? `yes (${out.fp})` : 'no'}, ` +
			`attachment ${result.authenticatorAttachment ?? '—'}, transports ${JSON.stringify(result.transports)}, id ${id.slice(0, 16)}…`,
		result.prfEnabled ? 'ok' : result.prfEnabled === false ? 'error' : '',
	);
	return result;
}

async function get(step: Exclude<StepName, 'create'>): Promise<Partial<StepResult>> {
	const { first, second } = await getSalts();
	const stored = loadStored();
	// `hints` (WebAuthn L3) is not in this TypeScript's lib.dom yet.
	const options: PublicKeyCredentialRequestOptions & { hints?: string[] } = {
		rpId: location.hostname,
		challenge: random(32),
		userVerification: 'required',
		timeout: TIMEOUT_MS,
		extensions: { prf: { eval: { first, second } } },
	};
	if (step === 'get-this') {
		if (!stored) throw new DOMException('no stored passkey: run step 1 first', 'NoStoredPasskey');
		options.allowCredentials = [{ type: 'public-key', id: fromB64url(stored.id) }];
	}
	if (step === 'get-hybrid') options.hints = ['hybrid'];

	const cred = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
	if (!cred) throw new DOMException('the browser returned no credential', 'UnknownError');

	const { first: a, second: b } = await prfOutputs(cred);
	const id = b64url(cred.rawId);
	const result: Partial<StepResult> = {
		credentialId: id,
		sameAsStored: stored ? stored.id === id : null,
		authenticatorAttachment: cred.authenticatorAttachment ?? null,
		prfReturned: !!a,
		prfFirst: a?.fp ?? null,
		prfSecond: b?.fp ?? null,
		prfLength: a?.length ?? null,
	};
	log(
		`${step}: PRF ${a ? `first ${a.fp}` : 'no output'}${b ? `, second ${b.fp}` : a ? ', no second' : ''}` +
			`${a && b ? (a.fp === b.fp ? ' (first = second!)' : ' (first ≠ second)') : ''}, ` +
			`attachment ${result.authenticatorAttachment ?? '—'}, id ${id.slice(0, 16)}…${result.sameAsStored ? ' (stored)' : ''}`,
		a ? 'ok' : 'error',
	);
	if (step === 'get-hybrid' && result.authenticatorAttachment === 'platform') {
		log('get-hybrid: answered by a passkey on this device, not a phone: counted as a local get');
	}
	return result;
}

const buttons = ['create', 'getThis', 'getAny', 'getHybrid'] as const;

async function runStep(step: StepName, fn: () => Promise<Partial<StepResult>>) {
	for (const b of buttons) $<HTMLButtonElement>(b).disabled = true;
	document.body.dataset.busy = '1';
	const started = performance.now();
	const at = new Date().toISOString();
	log(`${step}: started`);
	try {
		const result = await fn();
		steps.push({ step, at, ms: Math.round(performance.now() - started), ok: true, ...result });
	} catch (e) {
		const error = errorInfo(e);
		steps.push({ step, at, ms: Math.round(performance.now() - started), ok: false, error });
		log(`${step}: ${error.name}: ${error.message}`, 'error');
	} finally {
		for (const b of buttons) $<HTMLButtonElement>(b).disabled = false;
		delete document.body.dataset.busy;
		try {
			render();
		} catch (e) {
			log(`render: ${errorInfo(e).message}`, 'error');
		}
	}
}

// ---------------------------------------------------------------- copy

async function copyReport() {
	const text = JSON.stringify(buildReport());
	const status = $('copyStatus');
	try {
		await navigator.clipboard.writeText(text);
		status.textContent = `Report copied (${text.length} characters).`;
		return;
	} catch (e) {
		log(`clipboard: ${errorInfo(e).name}, trying the fallback`);
	}
	// Fallback: a selected textarea and execCommand, for browsers without the
	// async clipboard (or without permission for it).
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.append(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	ta.remove();
	if (ok) {
		status.textContent = `Report copied (${text.length} characters).`;
	} else {
		status.textContent = 'Could not copy: open "Report JSON" below, select it and copy by hand.';
		($('report').closest('details') as HTMLDetailsElement).open = true;
	}
}

// ---------------------------------------------------------------- start

$('create').addEventListener('click', () => runStep('create', create));
$('getThis').addEventListener('click', () => runStep('get-this', () => get('get-this')));
$('getAny').addEventListener('click', () => runStep('get-any', () => get('get-any')));
$('getHybrid').addEventListener('click', () => runStep('get-hybrid', () => get('get-hybrid')));
$('copy').addEventListener('click', () => void copyReport());
$('forget').addEventListener('click', () => {
	localStorage.removeItem(STORE_KEY);
	log('stored passkey id forgotten (the passkey itself stays in your password manager)');
	render();
});
$('clear').addEventListener('click', () => {
	steps.length = 0;
	$('log').replaceChildren();
	$('copyStatus').textContent = '';
	render();
});

render();
collectEnvironment()
	.catch((e) => log(`environment: ${errorInfo(e).name}: ${errorInfo(e).message}`, 'error'))
	.finally(() => {
		renderEnvironment();
		render();
		document.body.dataset.ready = '1';
		if (!window.isSecureContext) log('not a secure context: WebAuthn needs https (or localhost)', 'error');
		else if (environment.webauthn === false) log('this browser has no WebAuthn', 'error');
	});
