// UI E2E: the real app in a real chromium against the staging backend.
//
// WebAuthn runs through a CDP virtual authenticator (e2e/fixtures.ts), so the
// production passkey path executes with zero human input and no special build.
// The backend is live staging via the vite /api proxy; every run creates fresh
// accounts, so tests never depend on existing data.
//
// Run: npm run test:e2e   (starts vite itself when none is running)
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	// Staging is a shared, rate-limited backend and dialogs are stateful:
	// one worker keeps runs reproducible. Parallelism is a later optimization.
	workers: 1,
	fullyParallel: false,
	timeout: 180_000,
	expect: { timeout: 45_000 }, // cross-account sync rides staging long-polls
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL: 'http://localhost:5174',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	webServer: {
		command: 'npx vite --host 0.0.0.0 --port 5174 --strictPort',
		url: 'http://localhost:5174',
		reuseExistingServer: true,
		timeout: 60_000,
	},
});
