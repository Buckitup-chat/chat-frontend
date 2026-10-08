import { test as base, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, createAccount, armWebAuthn } from './fixtures';

const PASSWORD = 'Correct-Horse-9!';

base.use({ trace: 'off' });

const typePassword = async (page: Page) => {
	const field = page.locator('#password');
	await field.click();
	await field.fill(PASSWORD);
};

base('a backup downloaded from Identity restores the same account in a clean browser', async ({ browser }) => {
	const contextA = await browser.newContext({ acceptDownloads: true });
	const pageA = await contextA.newPage();
	const name = await createAccount(contextA, pageA, 'backup');

	await pageA.locator('._menu_btn').filter({ hasText: 'Account' }).first().click();
	await expect(pageA).toHaveURL(/\/account\/?$/);
	await expect(pageA.getByText(name).first()).toBeVisible();
	const hashRow = pageA.locator('label').filter({ hasText: 'User hash' });
	const shortHash = (await hashRow.innerText()).replace('User hash', '').trim();
	expect(shortHash).not.toBe('');

	await pageA.getByTitle('Download backup file').click();
	await expect(pageA.getByRole('dialog', { name: /Local Backup/ })).toBeVisible();
	await expect(pageA.getByText('BuckitUp network')).toHaveCount(0);
	await typePassword(pageA);
	const [download] = await Promise.all([
		pageA.waitForEvent('download'),
		pageA.getByRole('button', { name: 'Download Local Backup' }).click(),
	]);
	expect(download.suggestedFilename()).toMatch(/_encrypted\.bukitup$/);
	const filePath = await download.path();
	const body = await readFile(filePath, 'utf8');
	await contextA.close();

	const contextB = await browser.newContext();
	const pageB = await contextB.newPage();
	await armWebAuthn(contextB, pageB);
	await pageB.goto('/');
	await expect(pageB.getByText('Connect existing account')).toHaveCount(0);
	await pageB.getByRole('button', { name: 'Import from local backup' }).click();
	await pageB.locator('input[type=file][accept=".bukitup"]').setInputFiles({
		name: download.suggestedFilename(),
		mimeType: 'text/plain',
		buffer: Buffer.from(body),
	});
	await typePassword(pageB);
	await pageB.getByRole('button', { name: 'Decrypt and restore' }).click();

	await expect(pageB.locator('.wrapper')).toBeVisible({ timeout: 90_000 });
	await expect(pageB).toHaveURL(/\/account\/?$/);
	await expect(pageB.getByText(name).first()).toBeVisible();
	await expect(pageB.locator('label').filter({ hasText: 'User hash' })).toContainText(shortHash);
	await contextB.close();
});
