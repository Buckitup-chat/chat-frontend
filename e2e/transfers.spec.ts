// The transfer queue under a multi-file batch: cancelling one row must not
// kill the batch — the message goes out with the remaining attachments.
import { test, expect, openDialogWith, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('cancelling one file of a batch still delivers the rest', async () => {
	// two multi-chunk files so the queue is observable while it runs
	const big = (seed: number) =>
		Buffer.alloc(5 * 1024 * 1024).map((_, i) => (i * seed + 7) % 251);
	const keep = `keep-${Date.now().toString(36)}.bin`;
	const drop = `drop-${Date.now().toString(36)}.bin`;

	const chooser = alice.page.waitForEvent('filechooser');
	await alice.page.getByTitle('Attach a file').click();
	await (await chooser).setFiles([
		{ name: keep, mimeType: 'application/octet-stream', buffer: big(3) },
		{ name: drop, mimeType: 'application/octet-stream', buffer: big(5) },
	]);

	// the queue shows both rows; the second is waiting behind the first —
	// cancel it while it has not started
	const dropRow = alice.page.locator('.transfer-row').filter({ hasText: drop }).first();
	await expect(dropRow).toBeVisible({ timeout: 30_000 });
	await dropRow.locator('.transfer-cancel').click();

	// the message arrives with the kept file only
	await expect(bob.page.locator('.msg-file-name', { hasText: keep })).toBeVisible({ timeout: 180_000 });
	await expect(bob.page.locator('.msg-file-name', { hasText: drop })).toBeHidden();
	await expect(alice.page.locator('.msg-file-name', { hasText: drop })).toBeHidden();
});
