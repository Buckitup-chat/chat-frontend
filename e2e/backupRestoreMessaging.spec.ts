import { test as base, type BrowserContext, type Page, type Response } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, createAccount, armWebAuthn, openDialogWith, sendMessage } from './fixtures';

const PASSWORD = 'Correct-Horse-9!';

base.use({ trace: 'off' });

const typePassword = async (page: Page) => {
	const field = page.locator('#password');
	await field.click();
	await field.fill(PASSWORD);
};

const bubble = (page: Page, text: string) => page.locator('.message-bubble').filter({ hasText: text }).first();

type IngestSeen = { tables: string[]; status: number; errors: string[] };
const tablesOf = (request: import('@playwright/test').Request) => [
	...new Set([...(request.postData() ?? '').matchAll(/"relation":"([a-z_]+)"/g)].map((m) => m[1])),
];
const watchIngest = (page: Page) => {
	const seen: IngestSeen[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/ingest_each')) console.log('[e2e] ingest request', JSON.stringify(tablesOf(request)));
	});
	page.on('requestfailed', (request) => {
		if (request.url().includes('/ingest_each'))
			seen.push({ tables: tablesOf(request), status: 0, errors: [`request failed: ${request.failure()?.errorText}`] });
	});
	page.on('response', async (response: Response) => {
		if (!response.url().includes('/ingest_each')) return;
		const tables = tablesOf(response.request());
		let errors: string[] = [];
		try {
			errors = JSON.stringify(await response.json()).match(/"error[^"]*":"[^"]{0,120}"|invalid[_ ]signature[^"]{0,60}/g) ?? [];
		} catch {
			/* not JSON */
		}
		seen.push({ tables, status: response.status(), errors });
	});
	page.on('console', (msg) => {
		const text = msg.text();
		if (msg.type() === 'error' || msg.type() === 'warning' || /quarantin|invalid_signature|422|blocked/i.test(text))
			console.log(`[app ${msg.type()}]`, text.slice(0, 300));
	});
	return seen;
};
const signatureRefusals = (seen: IngestSeen[]) => seen.filter((r) => r.errors.some((e) => /invalid[_ ]signature/.test(e)));

const exportBackup = async (page: Page): Promise<{ name: string; body: string }> => {
	await page.locator('._menu_btn').filter({ hasText: 'Account' }).first().click();
	await page.getByTitle('Download backup file').click();
	await expect(page.getByRole('dialog', { name: /Local Backup/ })).toBeVisible();
	await typePassword(page);
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Download Local Backup' }).click(),
	]);
	return { name: download.suggestedFilename(), body: await readFile(await download.path(), 'utf8') };
};

const restoreBackup = async (context: BrowserContext, page: Page, file: { name: string; body: string }) => {
	await armWebAuthn(context, page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Import from local backup' }).click();
	await page.locator('input[type=file][accept=".bukitup"]').setInputFiles({
		name: file.name,
		mimeType: 'text/plain',
		buffer: Buffer.from(file.body),
	});
	await typePassword(page);
	await page.getByRole('button', { name: 'Decrypt and restore' }).click();
	await expect(page.locator('.wrapper')).toBeVisible({ timeout: 90_000 });
	await expect(page).toHaveURL(/\/account\/?$/);
};

const newContext = async (browser: import('@playwright/test').Browser) => {
	const context = await browser.newContext({ acceptDownloads: true });
	return { context, page: await context.newPage() };
};

base('an account restored from its backup file sends messages the server accepts', async ({ browser }) => {
	base.setTimeout(400_000);
	const original = await newContext(browser);
	const bob = await newContext(browser);
	const [aliceName, bobName] = await Promise.all([
		createAccount(original.context, original.page, 'restore-alice'),
		createAccount(bob.context, bob.page, 'restore-bob'),
	]);

	// Before the export: the original device writes to Bob.
	const beforeIngest = watchIngest(original.page);
	await openDialogWith(original.page, bobName);
	await openDialogWith(bob.page, aliceName);
	const before = `before-export ${Date.now().toString(36)}`;
	await sendMessage(original.page, before);
	await expect(bubble(bob.page, before)).toBeVisible({ timeout: 90_000 });
	console.log('[e2e] before export, ingest:', JSON.stringify(beforeIngest));
	expect(signatureRefusals(beforeIngest)).toEqual([]);

	const file = await exportBackup(original.page);
	await original.context.close();

	const restored = await newContext(browser);
	const afterIngest = watchIngest(restored.page);
	await restoreBackup(restored.context, restored.page, file);

	await openDialogWith(restored.page, bobName);
	const after = `after-restore ${Date.now().toString(36)}`;
	await sendMessage(restored.page, after);
	await expect
		.poll(() => afterIngest.some((r) => r.tables.includes('dialog_messages')), { timeout: 90_000 })
		.toBe(true);
	console.log('[e2e] after restore, ingest:', JSON.stringify(afterIngest));
	expect(signatureRefusals(afterIngest), 'no write is refused for its signature').toEqual([]);
	expect(afterIngest.filter((r) => r.tables.includes('dialog_messages')).map((r) => r.status)).toEqual([200]);
	await expect(bubble(bob.page, after)).toBeVisible({ timeout: 90_000 });

	await Promise.all([restored.context.close(), bob.context.close()]);
});
