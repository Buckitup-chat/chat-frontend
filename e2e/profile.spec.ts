// Editing the profile republishes the card: the peer's contact list shows the
// new name without any action on their side.
import { test, expect, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
});

test('a renamed profile reaches the peer through the replicated card', async () => {
	const newName = `${alice.name}-renamed`;

	await alice.page.locator('._menu_btn').filter({ hasText: 'Account' }).first().click();
	await alice.page.getByText('Identity').first().click();
	const nameInput = alice.page.locator('input[type=text]').first();
	await expect(nameInput).toHaveValue(alice.name, { timeout: 30_000 });
	await nameInput.fill(newName);
	await alice.page.getByRole('button', { name: /Save Changes/i }).click();

	// bob finds her under the new name — the card update replicated
	await bob.page.locator('._menu_btn').filter({ hasText: 'Chats' }).first().click();
	await bob.page.getByPlaceholder(/search/i).first().fill(newName);
	await expect(bob.page.locator('._user').filter({ hasText: newName }).first())
		.toBeVisible({ timeout: 90_000 });

	alice.name = newName; // later specs search by the current name
});
