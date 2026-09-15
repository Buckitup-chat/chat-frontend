// The front door: a fresh account through the production passkey path.
import { test as base } from '@playwright/test';
import { expect, createAccount } from './fixtures';

base('creates an account with a silent passkey and lands in the app', async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const name = await createAccount(context, page, 'solo');

	// the app is logged in: main layout up, account page reachable
	await expect(page.locator('.wrapper')).toBeVisible();
	await page.goto('/account');
	await expect(page.getByText(name).first()).toBeVisible();
	await context.close();
});
