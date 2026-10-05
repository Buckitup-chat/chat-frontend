#!/usr/bin/env node
// End-to-end check of the built sandbox in real Chromium: two pages with their
// own identities pass codes to each other through the page's test hook (in
// place of the cameras) and open a real WebRTC channel through QWBP, with no
// STUN. Then a third page impersonates the first one to the second.
//
//   npx vite build --config sandbox/handshake-pq2/vite.config.ts
//   node sandbox/handshake-pq2/scripts/check.mjs
//
// Headless Chromium hides host addresses behind mDNS names it cannot resolve
// without a camera permission; the flag below shows the addresses, as a phone
// that granted the camera does.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
	const path = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
	const file = path.startsWith(dist) && (await stat(path).then((s) => s.isFile(), () => false)) ? path : join(dist, 'index.html');
	res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
	res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/index.html?nocamera`;

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
let failed = false;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
};

const phone = async (init = {}) => {
	const context = await browser.newContext();
	await context.addInitScript((entries) => {
		for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
	}, init);
	const page = await context.newPage();
	page.on('pageerror', (e) => console.log('pageerror:', e.message));
	await page.goto(url);
	await page.waitForFunction(() => window.__pq2?.code());
	return page;
};

/** Each page reads the other's current code, alternating, until both are done or time runs out. */
const handshake = async (a, b, seconds = 30, pauseMs = 150) => {
	const until = Date.now() + seconds * 1000;
	while (Date.now() < until) {
		const [outA, outB] = await Promise.all([a.evaluate(() => window.__pq2.outcome()), b.evaluate(() => window.__pq2.outcome())]);
		if (outA && outB) return [outA, outB];
		const codeB = await b.evaluate(() => window.__pq2.code());
		await a.evaluate((c) => window.__pq2.read(c), codeB);
		const codeA = await a.evaluate(() => window.__pq2.code());
		await b.evaluate((c) => window.__pq2.read(c), codeA);
		await a.waitForTimeout(pauseMs);
	}
	return Promise.all([a.evaluate(() => window.__pq2.outcome()), b.evaluate(() => window.__pq2.outcome())]);
};

try {
	const alice = await phone();
	const bob = await phone();
	const [a, b] = await handshake(alice, bob);
	check('two phones confirm each other over a real WebRTC channel, no STUN', a?.kind === 'confirmed' && b?.kind === 'confirmed', `${a?.kind}/${b?.kind} ${a?.reason ?? ''}${b?.reason ?? ''}`);
	check('both show the same six digits', !!a?.code && a?.code === b?.code, `${a?.code} / ${b?.code}`);
	const opens = await Promise.all([alice, bob].map((p) => p.$$eval('#log li', (lis) => lis.filter((li) => li.textContent.endsWith('channel open')).length)));
	check('each phone opened one channel, and confirmed over it once', opens.every((n) => n === 1), opens.join(' / '));

	// Mallory met Alice before and holds her public card (as Bob's page now
	// does); she shows Alice's identity to Bob.
	const aliceCard = await bob.evaluate(() => JSON.parse(localStorage.getItem('pq2.lastPeerCard')));
	const mallory = await phone({ 'pq2.settings': JSON.stringify({ mode: 'impostor' }), 'pq2.lastPeerCard': JSON.stringify(aliceCard) });
	await bob.evaluate(() => document.getElementById('restart').click());
	await bob.waitForFunction(() => window.__pq2.stage() === 'A');
	const [, b2] = await handshake(mallory, bob);
	check('a phone showing Alice\'s identity with its own key is not confirmed by Bob', b2?.kind === 'verified' && /does not certify/.test(b2?.reason ?? ''), `${b2?.kind}: ${b2?.reason}`);
	check('…and Bob\'s screen named Alice\'s identity as the one shown', b2?.peerHash === aliceCard.user_hash);

	// Animated QR: no network channel at all, the proof goes through the codes.
	const framesMode = { 'pq2.settings': JSON.stringify({ channel: 'frames', frameSize: 'large', fps: 8 }) };
	const [carol, dave] = [await phone(framesMode), await phone(framesMode)];
	const started = Date.now();
	const [c, d] = await handshake(carol, dave, 60, 20);
	check('two phones confirm each other through animated QR, with no channel', c?.kind === 'confirmed' && d?.kind === 'confirmed', `${c?.kind}/${d?.kind} ${c?.reason ?? ''}${d?.reason ?? ''} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
	check('…and show the same six digits', !!c?.code && c?.code === d?.code, `${c?.code} / ${d?.code}`);

	// TURN, when a relay server is named (PQ2_TURN_URL, PQ2_TURN_USER,
	// PQ2_TURN_PASS): both pages offer only its addresses, so the channel can
	// only go through it.
	if (process.env.PQ2_TURN_URL) {
		const turnMode = {
			'pq2.settings': JSON.stringify({
				channel: 'turn', relayOnly: true, turnUrl: process.env.PQ2_TURN_URL,
				turnUser: process.env.PQ2_TURN_USER ?? '', turnPass: process.env.PQ2_TURN_PASS ?? '',
			}),
		};
		const [erin, frank] = [await phone(turnMode), await phone(turnMode)];
		const [e, f] = await handshake(erin, frank, 60);
		const offered = await erin.$$eval('#log li', (lis) => lis.map((li) => li.textContent).find((t) => t.includes('own payload')) ?? '');
		check('two phones confirm each other through the TURN relay', e?.kind === 'confirmed' && f?.kind === 'confirmed', `${e?.kind}/${f?.kind} ${e?.reason ?? ''}${f?.reason ?? ''}`);
		check('…offering the relay\'s addresses only', /offered: relay\//.test(offered) && !/host\//.test(offered), offered.trim());
	}
} finally {
	await browser.close();
	server.close();
}
process.exit(failed ? 1 : 0);
