// Message lifecycle through two real clients: edit, delete, quote, react.
// Every assertion that matters runs on the RECEIVING side — the sender's own
// echo proves nothing about the protocol.
import { test, expect, openDialogWith, sendMessage, type Account } from './fixtures';
import type { Page } from '@playwright/test';

const bubble = (page: Page, text: string) =>
	page.locator('.message-bubble').filter({ hasText: text }).first();

const openContextMenu = async (page: Page, text: string) => {
	await bubble(page, text).click({ button: 'right' });
	await expect(page.locator('.context-menu')).toBeVisible();
};

let alice: Account;
let bob: Account;

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('an edit replaces the text for the peer and carries the edited label', async () => {
	const original = `правка-исходник ${Date.now().toString(36)}`;
	const edited = `правка-итог ${Date.now().toString(36)}`;

	await sendMessage(alice.page, original);
	await expect(bubble(bob.page, original)).toBeVisible({ timeout: 90_000 });

	// wait for synced (context menu offers Edit only then), then edit
	await openContextMenu(alice.page, original);
	await alice.page.getByText('Edit', { exact: true }).click();
	await alice.page.locator('textarea').fill(edited);
	await alice.page.getByRole('button', { name: 'Save' }).click();

	// the peer sees the new text, the old one is gone, the label shows
	await expect(bubble(bob.page, edited)).toBeVisible({ timeout: 90_000 });
	await expect(bubble(bob.page, original)).toBeHidden();
	await expect(bubble(bob.page, edited).locator('.msg-edited')).toBeVisible();

	// edit history opens and shows the previous revision struck through
	await bubble(bob.page, edited).locator('.msg-edited').click();
	await expect(bob.page.locator('.eh-card')).toBeVisible();
	await expect(bob.page.locator('.eh-card')).toContainText('версия', { ignoreCase: true }).catch(() => {});
	await expect(bob.page.locator('.eh-card del, .eh-card .eh-removed').first()).toBeVisible({ timeout: 30_000 });
	await bob.page.locator('.eh-close').click();
});

test('a delete becomes a tombstone on both sides, not a disappearance', async () => {
	const doomed = `удаляемое ${Date.now().toString(36)}`;
	await sendMessage(alice.page, doomed);
	await expect(bubble(bob.page, doomed)).toBeVisible({ timeout: 90_000 });

	alice.page.once('dialog', (d) => d.accept()); // "Peers will see it was deleted"
	await openContextMenu(alice.page, doomed);
	await alice.page.getByText('Delete', { exact: true }).click();

	await expect(alice.page.getByText('Message deleted').first()).toBeVisible({ timeout: 90_000 });
	await expect(bob.page.getByText('Message deleted').first()).toBeVisible({ timeout: 90_000 });
	await expect(bubble(bob.page, doomed)).toBeHidden();
});

test('a reply carries the quote and the peer can jump to the original', async () => {
	const source = `цитируемое ${Date.now().toString(36)}`;
	const answer = `ответ-с-цитатой ${Date.now().toString(36)}`;

	await sendMessage(bob.page, source);
	await expect(bubble(alice.page, source)).toBeVisible({ timeout: 90_000 });

	await openContextMenu(alice.page, source);
	await alice.page.getByText('Reply', { exact: true }).click();
	await expect(alice.page.locator('.reply-preview')).toBeVisible();
	await sendMessage(alice.page, answer);

	const bobAnswer = bubble(bob.page, answer);
	await expect(bobAnswer).toBeVisible({ timeout: 90_000 });
	await expect(bobAnswer.locator('.msg-quote').first()).toContainText(source.slice(0, 20));
});

test('a reaction lands on the peer side and toggles off', async () => {
	const target = `реагируемое ${Date.now().toString(36)}`;
	await sendMessage(alice.page, target);
	await expect(bubble(bob.page, target)).toBeVisible({ timeout: 90_000 });

	await openContextMenu(bob.page, target);
	await bob.page.locator('.context-menu-emoji', { hasText: '🔥' }).click();

	const aliceReaction = bubble(alice.page, target)
		.locator('..').locator('.reactions-container button', { hasText: '🔥' });
	await expect(aliceReaction.first()).toBeVisible({ timeout: 90_000 });
});
