#!/usr/bin/env node
// Checks the offline shell of a production build in a real Chromium: the app
// is served the way the chat server serves it (the build under /app/, index.html
// for every other path), opened once online, and then reloaded with no network
// on a route deep inside the app — which must come from the service worker.
//
//   DOMAIN=buckitup.xyz npm run build   # the base the chat server uses
//   node scripts/check-offline-shell.mjs [dist]
//
// Exits non-zero when a step fails. Needs the Playwright Chromium
// (PLAYWRIGHT_BROWSERS_PATH, as for `npm run test:e2e`).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const dist = process.argv[2] ?? 'dist';
const BASE = '/app/';
const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
	'.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

const fileFor = async (pathname) => {
	const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.slice(1);
	const path = normalize(join(dist, rel));
	if (!path.startsWith(normalize(dist))) return null;
	try {
		return (await stat(path)).isFile() ? path : null;
	} catch {
		return null;
	}
};

const server = createServer(async (req, res) => {
	const { pathname } = new URL(req.url, 'http://localhost');
	const path = (await fileFor(decodeURIComponent(pathname))) ?? join(dist, 'index.html');
	res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
	res.end(await readFile(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
// The app keeps long-polls open, so `load` is not a signal worth waiting for.
const NAV = { waitUntil: 'domcontentloaded', timeout: 20_000 };
let failed = false;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
};

try {
	await page.goto(`${origin}/`, NAV);
	await page.waitForFunction(() => location.pathname.startsWith('/app/'), null, { timeout: 15_000 }).catch(() => {});
	check('the bare domain moves under the base', new URL(page.url()).pathname.startsWith(BASE), page.url());

	await page.goto(`${origin}/chat/u_example`, NAV);
	check('a route written without the base moves under it', new URL(page.url()).pathname === `${BASE}chat/u_example`, page.url());

	// The worker precaches the build and then claims open pages — those
	// created inside its scope: a page entered at another path and moved under
	// the base is controlled from its next load on, which is what a reload is.
	await page.goto(`${origin}${BASE}`, NAV);
	const controlled = await page
		.waitForFunction(() => navigator.serviceWorker?.controller?.scriptURL ?? false, null, { timeout: 45_000 })
		.then((handle) => handle.jsonValue())
		.catch(() => null);
	check('the service worker controls the page', !!controlled, controlled ?? 'no controller within 45 s');

	// The address the app moves to by itself — its router's choice, the one a
	// person reloads — must be one the worker serves.
	await page.waitForFunction((base) => location.pathname !== base, BASE, { timeout: 15_000 }).catch(() => {});
	const appPath = new URL(page.url()).pathname;
	await context.setOffline(true);
	const reloaded = await page.reload(NAV).then(() => true, () => false);
	check(`offline, a reload of the page the app is on (${appPath}) keeps the app`, reloaded && (await page.locator('#app').count()) === 1);

	for (const route of ['account/info', 'chats', 'chat/u_example']) {
		const response = await page.goto(`${origin}${BASE}${route}`, NAV).catch((e) => e);
		const loaded = !(response instanceof Error) && (await page.locator('#app').count()) === 1;
		check(`offline, ${BASE}${route} loads from the service worker`, loaded, response instanceof Error ? response.message.split('\n')[0] : '');
	}
} finally {
	await browser.close();
	server.close();
}
process.exit(failed ? 1 : 0);
