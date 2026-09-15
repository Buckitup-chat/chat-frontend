// A second tab of the same account: signs in against the same vault, sees the
// same dialog, and a message sent from it reaches both the first tab and the
// peer. Multiple tabs are an allowed configuration (repo invariant).
import { test, expect, openDialogWith, sendMessage, armWebAuthn, exportCredentials, importCredentials, reconnectAccount, type Account } from './fixtures';

// FIXME(harness): a second tab needs the account's passkey, but Chrome allows
// only ONE internal (platform) authenticator per browser context, and two tabs
// of one account must share a context (shared vault/storage — that is the whole
// point of the scenario). A dedicated tab authenticator collides with the
// account's; reusing the context's does not surface to the tab's target. The
// product supports multiple tabs (repo invariant); this is a virtual-
// authenticator limitation, not an app bug. Revisit if Playwright/Chrome gains
// per-context authenticator sharing across targets.

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test.fixme('a second tab joins the account and its message reaches everyone', async () => {
	const tab2 = await alice.page.context().newPage();
	try {
		// the tab gets its own authenticator carrying a copy of the passkey
		await armWebAuthn(alice.page.context(), tab2);
		await importCredentials(tab2, await exportCredentials(alice.page));
		await tab2.goto('/');
		await reconnectAccount(tab2);

		await openDialogWith(tab2, bob.name);
		const text = `из второй вкладки ${Date.now().toString(36)}`;
		await sendMessage(tab2, text);

		await expect(bob.page.locator('.message-bubble').filter({ hasText: text }).first())
			.toBeVisible({ timeout: 120_000 });
		await expect(alice.page.locator('.message-bubble').filter({ hasText: text }).first())
			.toBeVisible({ timeout: 120_000 });
	} finally {
		await tab2.close();
	}
});
