import { test, type Page } from '@playwright/test';
import { expect, createAccount, armWebAuthn, clearSiteData, exportCredentials, reconnectAccount, accountName } from './fixtures';

test.use({ trace: 'off' });

const openBackupCenter = async (page: Page) => {
	await page.locator('._menu_btn').filter({ hasText: 'Account' }).first().click();
	await page.locator('._sub_menu_btn').filter({ hasText: 'Backup Center' }).first().click();
	await expect(page.locator('[data-test="passkey-recovery-card"]')).toBeVisible();
};

test('recovery on → site data cleared → restored with the same passkey → ordinary sign-in', async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const name = await createAccount(context, page, 'pkrec');
	expect(await exportCredentials(page)).toHaveLength(1);

	await openBackupCenter(page);
	await page.locator('[data-test="passkey-recovery-consent"]').check();
	await page.locator('[data-test="passkey-recovery-on-button"]').click();
	await expect(page.locator('[data-test="passkey-recovery-device-bound"]')).toContainText('This passkey does not sync', { timeout: 30_000 });
	await page.locator('[data-test="passkey-recovery-device-bound-confirm"]').click();
	await expect(page.locator('[data-test="passkey-recovery-on"]')).toBeVisible({ timeout: 90_000 });

	await clearSiteData(page);
	await expect(page.getByText('Connect existing account')).toHaveCount(0);

	await page.locator('[data-test="restore-with-passkey"]').first().click();
	await expect(page.locator('.wrapper')).toBeVisible({ timeout: 90_000 });
	await expect(page.getByText(name).first()).toBeVisible();
	expect(await exportCredentials(page)).toHaveLength(1);

	await page.reload();
	await reconnectAccount(page);
	await expect(page.getByText(name).first()).toBeVisible();
	expect(await exportCredentials(page)).toHaveLength(1);
	await context.close();
});

test('a changed passkey opens the vault and withdraws the old copy only after the new copy is active', async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const name = await createAccount(context, page, 'pkchange');
	await openBackupCenter(page);
	await page.locator('[data-test="passkey-recovery-consent"]').check();
	await page.locator('[data-test="passkey-recovery-on-button"]').click();
	await expect(page.locator('[data-test="passkey-recovery-device-bound"]')).toBeVisible({ timeout: 30_000 });
	await page.locator('[data-test="passkey-recovery-device-bound-confirm"]').click();
	await expect(page.locator('[data-test="passkey-recovery-on"]')).toBeVisible({ timeout: 90_000 });

	await page.locator('[data-test="passkey-change-start"]').click();
	await expect(page.locator('[data-test="passkey-change-offer"]')).toBeVisible({ timeout: 90_000 });
	expect(await exportCredentials(page)).toHaveLength(2);
	await expect(page.locator('[data-test="passkey-recovery-others-note"]')).toBeVisible();
	await expect(page.locator('[data-test="passkey-change-withdraw-old"]')).toHaveCount(0);

	await page.locator('[data-test="passkey-recovery-consent"]').check();
	await page.locator('[data-test="passkey-recovery-on-button"]').click();
	await expect(page.locator('[data-test="passkey-recovery-device-bound"]')).toBeVisible({ timeout: 30_000 });
	await page.locator('[data-test="passkey-recovery-device-bound-confirm"]').click();
	await expect(page.locator('[data-test="passkey-change-withdraw-old"]')).toBeVisible({ timeout: 90_000 });
	await page.locator('[data-test="passkey-change-withdraw-old"]').click();
	await expect(page.locator('[data-test="passkey-change-offer"]')).toHaveCount(0);
	await expect(page.locator('[data-test="passkey-recovery-others-note"]')).toHaveCount(0);

	await page.reload();
	await reconnectAccount(page);
	await expect(page.getByText(name).first()).toBeVisible();
	expect(await exportCredentials(page)).toHaveLength(2);
	await context.close();
});

test('a passkey without PRF gets the older lock only after the person agrees, and no passkey recovery', async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await armWebAuthn(context, page, { prf: false });
	await page.goto('/');
	await page.getByRole('button', { name: 'Create new account' }).click();
	await page.locator('input[type=text]').first().fill(accountName('noprf'));
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(page.getByText('This passkey cannot lock the account the new way')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.locator('.wrapper')).toBeVisible({ timeout: 90_000 });

	await openBackupCenter(page);
	await expect(page.locator('[data-test="passkey-recovery-unavailable"]')).toBeVisible({ timeout: 30_000 });
	await context.close();
});

test('restoring with a passkey that has no recovery on says so, and changes nothing', async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await createAccount(context, page, 'pknone');
	await clearSiteData(page);
	await page.locator('[data-test="restore-with-passkey"]').first().click();
	await expect(page.getByText('No passkey recovery on this server')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText('Connect existing account')).toHaveCount(0);
	expect(await exportCredentials(page)).toHaveLength(1);
	await context.close();
});
