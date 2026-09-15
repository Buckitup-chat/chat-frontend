// Checkpoints: sign a state, watch the dialog move past it, see the concrete
// diff — and the alert dot that turns a stale pointer into a notification.
import { test, expect, openDialogWith, sendMessage, type Account } from './fixtures';
import type { Page } from '@playwright/test';

const bubble = (page: Page, text: string) =>
	page.locator('.message-bubble').filter({ hasText: text }).first();

// Three cross-account sync hops per test ride staging long-polls — the
// default budget is for one.
test.describe.configure({ timeout: 360_000 });

let alice: Account;
let bob: Account;

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('signing a checkpoint puts the marker in both feeds and matches itself', async () => {
	const before = `до чекпойнта ${Date.now().toString(36)}`;
	await sendMessage(alice.page, before);
	await expect(bubble(bob.page, before)).toBeVisible({ timeout: 90_000 });

	await alice.page.locator('.chat-header').getByRole('button').first().click();
	await expect(alice.page.locator('.swal2-popup')).toContainText('Checkpoint signed', { timeout: 60_000 });
	await alice.page.locator('.swal2-popup').waitFor({ state: 'hidden' });

	// the marker is an ordinary message: it replicates to the peer too
	await expect(alice.page.locator('.msg-checkpoint').first()).toBeVisible({ timeout: 120_000 });
	await expect(bob.page.locator('.msg-checkpoint').first()).toBeVisible({ timeout: 120_000 });

	// right after signing the state matches exactly
	await alice.page.locator('.msg-checkpoint').last().click();
	await expect(alice.page.locator('.swal2-popup')).toContainText('EXACT_MATCH', { timeout: 60_000 });
	await alice.page.locator('.swal2-close').click();
});

test('the diff modal shows the concrete change and the future marker', async () => {
	const after = `после чекпойнта ${Date.now().toString(36)}`;
	await sendMessage(bob.page, after);
	await expect(bubble(alice.page, after)).toBeVisible({ timeout: 90_000 });

	await alice.page.locator('.msg-checkpoint').last().click();
	// bob's message is ahead of the pointer → collapsed future marker
	const modal = alice.page.locator('.cd-card');
	await expect(modal).toBeVisible({ timeout: 60_000 });
	await expect(modal.locator('.cd-change._future')).toContainText('new message');
	await modal.locator('.cd-close').click();
});

test('the dialogs list grows an alert dot and the dot opens the comparison', async () => {
	// alice returns to the list; the sweep finds her checkpoint outrun
	await alice.page.locator('._menu_btn').filter({ hasText: 'Chats' }).first().click();
	const bobRow = alice.page.locator('._user').filter({ hasText: bob.name }).first();
	await expect(bobRow.locator('._checkpoint_dot')).toBeVisible({ timeout: 90_000 });

	await bobRow.locator('._checkpoint_dot').click();
	// lands in the dialog with the comparison already open
	await expect(alice.page.locator('.cd-card')).toBeVisible({ timeout: 90_000 });
	await alice.page.locator('.cd-close').click();
});
