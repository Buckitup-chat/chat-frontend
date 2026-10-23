#!/usr/bin/env node
// The app's handshake in real Chromium: two pages, each a phone with its own
// identity, pass codes to each other through the page's hook (in place of the
// cameras) and open a real WebRTC channel through the app's QwbpChannel and
// the patched QWBP — with no ICE server, as on a shared network. A third page
// then impersonates the first one to the second.
//
// With PQ2_TURN_URL, PQ2_TURN_USER and PQ2_TURN_PASS (a TURN server, e.g. the
// coturn command in docs/task-handshake-pq2-rollout.md), two more pages offer
// the relay's addresses only — two pages on one host would otherwise connect
// directly — and the check asserts from getStats() that the selected pair's
// local candidate is a relay one.
//
//   npm run test:handshake      (builds the page first; or node scripts/handshake-check/check.mjs)
//
// Needs no backend. Headless Chromium hides host addresses behind mDNS names
// it cannot resolve without a camera permission; the flag below shows the
// addresses, as a phone that granted the camera does.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
await build({ configFile: join(here, 'vite.config.ts'), mode: 'handshake-check', logLevel: 'warn' });

const dist = join(here, 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
	const path = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
	const file = path.startsWith(dist) && (await stat(path).then((s) => s.isFile(), () => false)) ? path : join(dist, 'index.html');
	res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
	res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/index.html`;

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
let failed = false;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
};

/** Any request a page makes: a handshake talks to no server. */
const requests = [];
const phone = async (query = {}, session = {}) => {
	const context = await browser.newContext();
	await context.addInitScript((entries) => {
		for (const [k, v] of Object.entries(entries)) sessionStorage.setItem(k, v);
	}, session);
	const page = await context.newPage();
	page.on('pageerror', (e) => console.log('pageerror:', e.message));
	page.on('request', (r) => { if (!r.url().startsWith(base.replace('/index.html', ''))) requests.push(r.url()); });
	await page.goto(`${base}?${new URLSearchParams(query)}`);
	await page.waitForFunction(() => window.__pq2?.code());
	return page;
};

const outcomeOf = (p) => p.evaluate(() => window.__pq2.outcome());

/** Each page reads the other's current code, alternating, until both are done or time runs out. */
const handshake = async (a, b, seconds = 40, pauseMs = 150) => {
	const until = Date.now() + seconds * 1000;
	while (Date.now() < until) {
		const [outA, outB] = await Promise.all([outcomeOf(a), outcomeOf(b)]);
		if (outA && outB) return [outA, outB];
		await a.evaluate((c) => window.__pq2.read(c), await b.evaluate(() => window.__pq2.code()));
		await b.evaluate((c) => window.__pq2.read(c), await a.evaluate(() => window.__pq2.code()));
		await a.waitForTimeout(pauseMs);
	}
	return Promise.all([outcomeOf(a), outcomeOf(b)]);
};

const opened = (p) => p.evaluate(() => window.__pq2.log().filter((l) => l === 'channel open').length);

try {
	const alice = await phone({ name: 'Alice' });
	const bob = await phone({ name: 'Bob' });
	const [a, b] = await handshake(alice, bob);
	check('two pages confirm each other over a real WebRTC channel, with no ICE server', a?.kind === 'confirmed' && b?.kind === 'confirmed', `${a?.kind}/${b?.kind} ${a?.reason ?? ''}${b?.reason ?? ''}`);
	check('both show the same six digits', !!a?.sas && a.sas === b?.sas, `${a?.sas} / ${b?.sas}`);
	check('each confirms with the other\'s card', a?.card?.name === 'Bob' && b?.card?.name === 'Alice');
	const opens = await Promise.all([alice, bob].map(opened));
	check('each opened one channel', opens.every((n) => n === 1), opens.join(' / '));
	const configs = await alice.evaluate(() => window.__pq2.connections());
	check('the connection had no ICE server at all', configs.length === 1 && configs[0].iceServers.length === 0, JSON.stringify(configs));
	const pair = await alice.evaluate(() => window.__pq2.selectedPair());
	check('…and went directly, with no relay on either side', pair?.local === 'host' && ['host', 'prflx'].includes(pair?.remote), JSON.stringify(pair));

	// Mallory holds Alice's public card and shows Alice's identity with her own key.
	const aliceCard = await alice.evaluate(() => window.__pq2.card());
	const mallory = await phone({ name: 'Mallory' }, { 'pq2.impostor': JSON.stringify(aliceCard) });
	const bob2 = await phone({ name: 'Bob' });
	const [, b2] = await handshake(mallory, bob2);
	check('a page showing Alice\'s identity with its own key is not confirmed', b2?.kind === 'verified' && /does not certify/.test(b2?.reason ?? ''), `${b2?.kind}: ${b2?.reason}`);
	check('…and the result names the identity it showed', b2?.peerHash === aliceCard.user_hash);

	if (process.env.PQ2_TURN_URL) {
		const relay = { turn: process.env.PQ2_TURN_URL, user: process.env.PQ2_TURN_USER ?? '', pass: process.env.PQ2_TURN_PASS ?? '', relayOnly: '' };
		const [erin, frank] = [await phone({ name: 'Erin', ...relay }), await phone({ name: 'Frank', ...relay })];
		const [e, f] = await handshake(erin, frank, 60);
		check('two pages confirm each other through the relay', e?.kind === 'confirmed' && f?.kind === 'confirmed', `${e?.kind}/${f?.kind} ${e?.reason ?? ''}${f?.reason ?? ''}`);
		const offered = (await erin.evaluate(() => window.__pq2.log())).find((l) => l.startsWith('offered:')) ?? '';
		check('…offering the relay\'s addresses only', /relay\//.test(offered) && !/host\/|srflx\//.test(offered), offered);
		const relayed = await erin.evaluate(() => window.__pq2.selectedPair());
		check('…and the selected pair\'s local candidate is a relay one', relayed?.local === 'relay', JSON.stringify(relayed));
	} else {
		console.log('skip relay case: PQ2_TURN_URL is not set');
	}
	check('no request to any server during the handshakes', requests.length === 0, requests.join(', '));
} finally {
	await browser.close();
	server.close();
}
process.exit(failed ? 1 : 0);
