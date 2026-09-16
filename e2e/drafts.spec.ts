// Unsent input survives leaving the dialog: typed text comes back when the
// user returns, and sending clears it.
import { test, expect, openDialogWith, sendMessage, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
});

test('a draft survives leaving and reopening the dialog', async () => {
	const draft = `недописанное ${Date.now().toString(36)}`;
	await openDialogWith(alice.page, bob.name);
	await alice.page.getByPlaceholder('Type a message...').fill(draft);
	// the save is debounced off the keystroke
	await alice.page.waitForTimeout(600);

	// leave for the contacts tab, come back
	await alice.page.locator('._menu_btn').filter({ hasText: 'Contacts' }).first().click();
	await openDialogWith(alice.page, bob.name);
	await expect(alice.page.getByPlaceholder('Type a message...')).toHaveValue(draft, { timeout: 15_000 });

	// sending clears the stored draft: leave and return again — input empty
	await sendMessage(alice.page, draft);
	await alice.page.locator('._menu_btn').filter({ hasText: 'Contacts' }).first().click();
	await openDialogWith(alice.page, bob.name);
	await alice.page.waitForTimeout(600);
	await expect(alice.page.getByPlaceholder('Type a message...')).toHaveValue('');
});
