// A real (tiny) video, recorded by the browser itself, travels chunked and
// encrypted; the receiver gets a playable frame, not a file row.
import { test, expect, openDialogWith, type Account } from './fixtures';

let alice: Account;
let bob: Account;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ pair }) => {
	({ alice, bob } = pair);
	await openDialogWith(alice.page, bob.name);
	await openDialogWith(bob.page, alice.name);
});

test('a video arrives as a playable frame with a play affordance', async () => {
	// no binary fixture: chromium records its own canvas into a webm it is
	// guaranteed to decode — which the sender-side preview builder requires
	const b64 = await alice.page.evaluate(async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 64; canvas.height = 64;
		const ctx = canvas.getContext('2d')!;
		const stream = (canvas as HTMLCanvasElement).captureStream(24);
		const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
		const chunks: Blob[] = [];
		rec.ondataavailable = (e) => chunks.push(e.data);
		const done = new Promise<void>((r) => { rec.onstop = () => r(); });
		rec.start();
		for (let i = 0; i < 20; i++) {
			ctx.fillStyle = `hsl(${i * 18}, 80%, 50%)`;
			ctx.fillRect(0, 0, 64, 64);
			await new Promise((r) => setTimeout(r, 40));
		}
		rec.stop();
		await done;
		const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
		let s = ''; for (const byte of buf) s += String.fromCharCode(byte);
		return btoa(s);
	});

	const chooser = alice.page.waitForEvent('filechooser');
	await alice.page.getByTitle('Attach a file').click();
	await (await chooser).setFiles([{
		name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(b64, 'base64'),
	}]);

	// receiver renders the video frame (aspect + thumbhash from the envelope)
	// with the play triangle — not a document row
	await expect(bob.page.locator('.msg-video-frame').first()).toBeVisible({ timeout: 120_000 });
	await expect(bob.page.locator('.msg-video-triangle').first()).toBeVisible();
});
