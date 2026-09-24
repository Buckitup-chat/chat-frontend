import { test, expect, openDialogWith, sendMessage, reconnectAccount, type Account } from './fixtures';
import type { Page } from '@playwright/test';

const bubbles = (page: Page, text: string) => page.locator('.message-bubble').filter({ hasText: text });

const isBackend = (url: URL) => url.pathname.startsWith('/api/');
const goOffline = (page: Page) => page.route(isBackend, (route) => route.abort('internetdisconnected'));
const goOnline = (page: Page) => page.unroute(isBackend);

const projectionKeys = (page: Page) => page.evaluate(async () => {
	const dbs = await indexedDB.databases();
	if (!dbs.some((d) => d.name === 'buckitup-message-projections')) return null;
	return new Promise<string[]>((resolve, reject) => {
		const req = indexedDB.open('buckitup-message-projections');
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('transactions')) { db.close(); resolve([]); return; }
			const r = db.transaction('transactions').objectStore('transactions').getAllKeys();
			r.onsuccess = () => { db.close(); resolve(r.result.map(String)); };
		};
	});
});

let alice: Account;
let bob: Account;

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
	const history = `history ${Date.now().toString(36)}`;
	await sendMessage(alice.page, history);
	await expect(bubbles(bob.page, history).first()).toBeVisible({ timeout: 90_000 });
});

test('MSG-04: an offline message survives a hard reload, then goes out once and is replaced by its echo', async () => {
	const page = alice.page;
	const text = `offline-reload ${Date.now().toString(36)}`;
	const ingestWithText: string[] = [];

	await goOffline(page);
	await sendMessage(page, text);
	const messageId = await bubbles(page, text).first().getAttribute('data-msg-id');
	expect(messageId).toBeTruthy();

	await expect.poll(() => projectionKeys(page), { timeout: 30_000 }).toContain(`projection:${messageId}`);
	console.log('[e2e] projection keys before reload:', await projectionKeys(page));

	await page.reload();
	await reconnectAccount(page);
	console.log('[e2e] projection keys after reload:', await projectionKeys(page));
	await openDialogWith(page, bob.name);
	await expect(bubbles(page, text).first()).toBeVisible({ timeout: 30_000 });
	expect(await bubbles(page, text).first().getAttribute('data-msg-id')).toBe(messageId);
	await expect(bubbles(bob.page, text)).toHaveCount(0);

	page.on('request', (req) => {
		if (req.url().includes('/ingest_each') && req.postData()?.includes(messageId!)) ingestWithText.push(req.url());
	});
	await goOnline(page);
	await expect(bubbles(bob.page, text).first()).toBeVisible({ timeout: 120_000 });

	await expect.poll(async () => (await projectionKeys(page))?.includes(`projection:${messageId}`), { timeout: 60_000 }).toBe(false);
	await expect(bubbles(page, text)).toHaveCount(1);
	expect(ingestWithText.length).toBeGreaterThanOrEqual(1);
	console.log('[e2e] ingest_each requests carrying the message:', ingestWithText.length);
});
