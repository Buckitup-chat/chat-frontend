// The offline write path end to end: a message sent with no network becomes a
// durable outbox entry, and the return of connectivity delivers it — to the
// peer's screen, not just to a local status.
import { test, expect, openDialogWith, sendMessage, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('a message sent offline is delivered after reconnect', async () => {
	const text = `из офлайна ${Date.now().toString(36)}`;
	const context = alice.page.context();
	try {
		await context.setOffline(true);
		await sendMessage(alice.page, text); // optimistic bubble, durable entry
		await alice.page.waitForTimeout(3000);
		await expect(bob.page.locator('.message-bubble').filter({ hasText: text })).toBeHidden();
	} finally {
		await context.setOffline(false);
	}
	// the online listener + drain loop replay the durable entry
	await expect(bob.page.locator('.message-bubble').filter({ hasText: text }).first())
		.toBeVisible({ timeout: 120_000 });
});
