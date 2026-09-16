// A full page load drops the unlocked vault; the same silent passkey signs
// back in, and the persisted history (wa-sqlite over OPFS) is still there.
import { test, expect, openDialogWith, sendMessage, reconnectAccount, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('reload → re-login with the same passkey → history intact', async () => {
	const text = `до перезагрузки ${Date.now().toString(36)}`;
	await sendMessage(alice.page, text);
	await expect(bob.page.locator('.message-bubble').filter({ hasText: text }).first())
		.toBeVisible({ timeout: 90_000 });

	// the context's authenticator (and its now-discoverable passkey) survives
	// the reload; only the vault relocks
	await alice.page.reload();
	await reconnectAccount(alice.page);

	await openDialogWith(alice.page, bob.name);
	await expect(alice.page.locator('.message-bubble').filter({ hasText: text }).first())
		.toBeVisible({ timeout: 60_000 });
});
