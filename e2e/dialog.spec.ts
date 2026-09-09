// Two real browsers, two fresh accounts, one dialog — everything between them
// travels through the staging backend: card replication, key wrap, message
// sync. This is the async-synchronization test the protocol tests cannot be:
// it watches the UI of the RECEIVING side.
import { test, expect, openDialogWith, sendMessage } from './fixtures';

test('two accounts find each other by name and exchange messages', async ({ pair }) => {
	const { alice, bob } = pair;

	// Alice finds Bob manually — search by name in the users list, no QR
	await openDialogWith(alice.page, bob.name);
	const hello = `привет от алисы ${Date.now().toString(36)}`;
	await sendMessage(alice.page, hello);

	// Bob opens the dialog from his side and the message arrives through
	// staging: card verified, keys unwrapped, content decrypted — or nothing
	// shows. The gate makes "visible" mean "verified".
	await openDialogWith(bob.page, alice.name);
	await expect(bob.page.locator('.message-bubble').filter({ hasText: hello }).first())
		.toBeVisible({ timeout: 90_000 });

	// and back
	const reply = `ответ боба ${Date.now().toString(36)}`;
	await sendMessage(bob.page, reply);
	await expect(alice.page.locator('.message-bubble').filter({ hasText: reply }).first())
		.toBeVisible({ timeout: 90_000 });
});
