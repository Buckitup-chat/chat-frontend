// Attachments over the wire: a document and a picture travel chunked and
// encrypted, and the RECEIVING client renders them — name and size for the
// file, an actual decoded image for the picture.
import { test, expect, openDialogWith, type Account } from './fixtures';

// smallest valid PNG: 1x1 red pixel
const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64');

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 360_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('a document arrives as a file row with its name', async () => {
	const name = `акт-${Date.now().toString(36)}.pdf`;
	const chooser = alice.page.waitForEvent('filechooser');
	await alice.page.getByTitle('Attach a file').click();
	await (await chooser).setFiles([{
		name, mimeType: 'application/pdf',
		buffer: Buffer.from(`fake pdf ${name} `.repeat(2000)),
	}]);

	// sender sees the transfer complete and the row appear
	await expect(alice.page.locator('.msg-file-name', { hasText: name })).toBeVisible({ timeout: 120_000 });
	// receiver gets the same row — manifest, chunks and envelope all synced
	await expect(bob.page.locator('.msg-file-name', { hasText: name })).toBeVisible({ timeout: 120_000 });
});

test('a picture arrives as a picture, not a file row', async () => {
	const chooser = alice.page.waitForEvent('filechooser');
	await alice.page.getByTitle('Attach a file').click();
	await (await chooser).setFiles([{ name: 'dot.png', mimeType: 'image/png', buffer: PNG_1PX }]);

	// the receiver renders an image element for it (auto-fetch + decrypt),
	// not a document row
	await expect(bob.page.locator('.msg-image').first()).toBeVisible({ timeout: 120_000 });
	await expect(bob.page.locator('.msg-image-full').first()).toBeVisible({ timeout: 120_000 });
});
