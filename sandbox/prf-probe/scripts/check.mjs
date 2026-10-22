#!/usr/bin/env node
// End-to-end check of the built PRF probe in real Chromium, against Chrome's
// virtual authenticator (CDP WebAuthn domain) in place of a phone:
//
//   1. an authenticator with PRF (hmac-secret): create, get this passkey
//      twice, get any passkey — PRF enabled, the same fingerprint on every
//      get, first ≠ second, and the report (rendered and copied) parses;
//   2. an authenticator without PRF: create and get succeed and the page
//      says "no PRF", with no error.
//
//   npm run build                                   # or: npm run build:sandbox:prf
//   node sandbox/prf-probe/scripts/check.mjs        # serves dist/sandbox/prf-probe
//
// PRF_PROBE_DIST names another directory to serve (e.g. sandbox/prf-probe/dist
// after `npx vite build --config sandbox/prf-probe/vite.config.ts`).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dist = resolve(process.env.PRF_PROBE_DIST ?? join(root, 'dist', 'sandbox', 'prf-probe'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

if (!(await stat(join(dist, 'index.html')).then((s) => s.isFile(), () => false))) {
	console.error(`no build at ${dist}: run \`npm run build:sandbox:prf\` first`);
	process.exit(2);
}

const server = createServer(async (req, res) => {
	const path = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
	const file = path.startsWith(dist) && (await stat(path).then((s) => s.isFile(), () => false)) ? path : join(dist, 'index.html');
	res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
	res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// localhost, not 127.0.0.1: an IP address cannot be a WebAuthn RP ID.
const url = `http://localhost:${server.address().port}/index.html`;

const browser = await chromium.launch();
let failed = false;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
};

/** Adds a virtual platform authenticator to the page's browser profile. */
const addAuthenticator = async (cdp, { hasPrf = true, isUserVerified = true } = {}) =>
	(
		await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				ctap2Version: 'ctap2_1',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified,
				hasPrf,
				automaticPresenceSimulation: true,
			},
		})
	).authenticatorId;

/** A fresh browser profile with a virtual platform authenticator. */
const open = async (options) => {
	const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const authenticatorId = await addAuthenticator(cdp, options);
	await page.goto(url);
	await page.waitForSelector('body[data-ready]');
	return { page, errors, context, cdp, authenticatorId };
};

const report = (page) => page.$eval('#report', (el) => JSON.parse(el.textContent));

/** Clicks a step's button and waits for its result in the report. */
const step = async (page, button) => {
	const before = (await report(page)).steps.length;
	await page.click(`#${button}`);
	await page.waitForFunction((n) => JSON.parse(document.getElementById('report').textContent).steps.length > n, before, { timeout: 30_000 });
	const r = await report(page);
	const s = r.steps.at(-1);
	console.log(`     ${s.step}: ${JSON.stringify(s)}`);
	return s;
};

try {
	console.log('-- authenticator with PRF');
	{
		const { page, errors, context } = await open({ hasPrf: true });
		const env = (await report(page)).environment;
		console.log(`     environment: ${JSON.stringify({ ...env, userAgent: undefined })}`);
		const c = await step(page, 'create');
		check('create succeeds', c.ok, c.error ? `${c.error.name}: ${c.error.message}` : '');
		check('PRF enabled at create', c.prfEnabled === true, String(c.prfEnabled));
		const g1 = await step(page, 'getThis');
		const g2 = await step(page, 'getThis');
		check('both gets of this passkey return PRF first and second', [g1, g2].every((g) => g.ok && g.prfFirst && g.prfSecond));
		check('…for the stored passkey', g1.sameAsStored === true && g2.credentialId === c.credentialId);
		check('the same first fingerprint across the two gets', !!g1.prfFirst && g1.prfFirst === g2.prfFirst, `${g1.prfFirst} / ${g2.prfFirst}`);
		check('…and the same second fingerprint', !!g1.prfSecond && g1.prfSecond === g2.prfSecond, `${g1.prfSecond} / ${g2.prfSecond}`);
		check('first ≠ second', g1.prfFirst !== g1.prfSecond, `${g1.prfFirst} / ${g1.prfSecond}`);
		check('a fingerprint is 8 hex characters, the output 32 bytes', /^[0-9a-f]{8}$/.test(g1.prfFirst ?? '') && g1.prfLength === 32);
		if (c.prfFirstAtCreate) check('the output at create matches the gets', c.prfFirstAtCreate === g1.prfFirst, `${c.prfFirstAtCreate}`);
		else console.log('     (no PRF output at create on this authenticator)');
		const any = await step(page, 'getAny');
		check('get any passkey picks the one made and returns PRF', any.ok && any.credentialId === c.credentialId && any.prfFirst === g1.prfFirst);
		const hybrid = await step(page, 'getHybrid');
		console.log(`     (the hybrid hint, answered by the virtual internal authenticator, informational: ok=${hybrid.ok} prf=${hybrid.prfReturned ?? '—'} ${hybrid.error?.name ?? ''})`);
		if (hybrid.ok && hybrid.authenticatorAttachment === 'platform') {
			check('a local passkey picked in the hybrid step does not count as a phone', (await report(page)).summary.prfViaHybrid === null);
		}

		const rendered = await report(page);
		check('summary: PRF works, deterministic, first ≠ second', rendered.summary.verdict === 'PRF works' && rendered.summary.deterministic === true && rendered.summary.firstDiffersFromSecond === true, JSON.stringify(rendered.summary));
		await page.click('#copy');
		await page.waitForFunction(() => document.getElementById('copyStatus').textContent);
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		let parsed = null;
		try {
			parsed = JSON.parse(copied);
		} catch (e) {
			console.log(`     copied text does not parse: ${e.message}`);
		}
		check('the copied report is compact JSON with the environment, summary and steps', !!parsed && !copied.includes('\n') && !!parsed.environment?.origin && parsed.summary?.verdict === 'PRF works' && parsed.steps?.length === rendered.steps.length, `${copied.length} characters`);
		const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
		check('localStorage holds the credential id and time only', Object.keys(stored).length === 1 && Object.keys(JSON.parse(stored['prfProbe.credential'])).sort().join() === 'createdAt,id', JSON.stringify(stored));
		check('no page errors', errors.length === 0, errors.join('; '));
		await context.close();
	}

	console.log('-- authenticator without PRF');
	{
		const { page, errors, context } = await open({ hasPrf: false });
		const c = await step(page, 'create');
		check('create succeeds', c.ok, c.error ? `${c.error.name}: ${c.error.message}` : '');
		check('PRF not enabled at create', c.prfEnabled !== true && !c.prfFirstAtCreate, String(c.prfEnabled));
		const g = await step(page, 'getThis');
		check('get succeeds without PRF output', g.ok && !g.prfReturned && !g.prfFirst && !g.prfSecond, g.error ? `${g.error.name}: ${g.error.message}` : '');
		const { summary } = await report(page);
		check('summary: no PRF', summary.verdict === 'no PRF' && summary.prfOutputAtGet === false, JSON.stringify(summary));
		const verdict = await page.$eval('#summary', (dl) => dl.querySelector('dd').textContent);
		check('the page shows "no PRF"', verdict === 'no PRF', verdict);
		check('no page errors', errors.length === 0, errors.join('; '));
		await context.close();
	}

	console.log('-- failing steps do not break the others');
	{
		const { page, errors, context, cdp, authenticatorId } = await open({ isUserVerified: false });
		const early = await step(page, 'getThis');
		check('get this passkey before create fails with a named error', !early.ok && early.error?.name === 'NoStoredPasskey', JSON.stringify(early.error));
		const refused = await step(page, 'create');
		check('create without user verification fails and is reported', !refused.ok && !!refused.error?.name, JSON.stringify(refused.error));
		// A fresh authenticator that verifies the user (in Chromium 151,
		// WebAuthn.setUserVerified on the old one did not let the next create pass).
		await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
		await addAuthenticator(cdp);
		const c = await step(page, 'create');
		const g = await step(page, 'getThis');
		check('then create and get work', c.ok && g.ok && g.prfReturned === true);
		const log = await page.$$eval('#log li.error', (lis) => lis.map((li) => li.textContent));
		check('the errors are on screen', log.some((t) => t.includes('NoStoredPasskey')) && log.some((t) => t.includes(refused.error?.name ?? '?')), `${log.length} error lines`);
		check('no page errors', errors.length === 0, errors.join('; '));
		await context.close();
	}
} finally {
	await browser.close();
	server.close();
}
process.exit(failed ? 1 : 0);
