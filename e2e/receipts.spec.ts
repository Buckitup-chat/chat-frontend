// Delivery is a fact and reports itself (✓✓ on verified arrival); reading is
// a choice and never reports without the explicit action (repo invariant:
// read receipts must not fire on render/scroll).
import { test, expect, openDialogWith, sendMessage, type Account } from './fixtures';
import type { Page } from '@playwright/test';

const bubble = (page: Page, text: string) =>
	page.locator('.message-bubble').filter({ hasText: text }).first();

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('delivery turns into ✓✓ by itself; read only after the explicit action', async () => {
	const text = `квитанции ${Date.now().toString(36)}`;
	await sendMessage(alice.page, text);

	// bob's client verifies the arrival and the delivered receipt comes back
	await expect(bubble(bob.page, text)).toBeVisible({ timeout: 90_000 });
	await expect(bubble(alice.page, text).locator('.sync-status.delivered'))
		.toBeVisible({ timeout: 90_000 });

	// rendering alone must NOT have produced a read receipt
	await expect(bubble(alice.page, text).locator('.sync-status.acknowledged')).toBeHidden();

	// the explicit action does
	await bubble(bob.page, text).click({ button: 'right' });
	await bob.page.getByText('Confirm read').click();
	await expect(bubble(alice.page, text).locator('.sync-status.acknowledged'))
		.toBeVisible({ timeout: 90_000 });
});
