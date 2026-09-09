// Shared machinery for UI E2E.
//
// The passkey problem is solved without touching the app: a CDP virtual
// authenticator (platform transport, user verification on, presence simulated)
// makes every navigator.credentials call resolve silently, so the production
// WebAuthn path — vault, key generation, card publication — runs exactly as it
// does for a real user.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

export { expect };

/** Attach a silent platform authenticator to a page. Must run before the app
 * checks isUserVerifyingPlatformAuthenticatorAvailable — i.e. before goto. */
export async function armWebAuthn(context: BrowserContext, page: Page): Promise<void> {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
}

/** Unique per run, unique per role: account names double as search keys, so
 * two runs on the shared staging backend must never collide. */
export const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const accountName = (role: string) => `e2e-${role}-${runId}`;

/**
 * Create a fresh account through the real UI and land in the app.
 * Returns the account name (its search key in other clients).
 */
export async function createAccount(context: BrowserContext, page: Page, role: string): Promise<string> {
	const name = accountName(role);
	await armWebAuthn(context, page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Create new account' }).click();
	await page.locator('input[type=text]').first().fill(name);
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	// account creation publishes the card to staging and logs in
	await expect(page.locator('.wrapper')).toBeVisible({ timeout: 90_000 });
	return name;
}

/** Open the dialog with a peer by their visible name — the manual path a user
 * takes: chats list → search → tap the row. */
export async function openDialogWith(page: Page, peerName: string): Promise<void> {
	// In-app navigation only: a full page load drops the unlocked vault and
	// lands on the login screen — reload/re-auth is its own scenario, not a
	// side effect every test pays for.
	await page.getByText('Chats', { exact: true }).click();
	const search = page.getByPlaceholder(/search/i).first();
	await search.fill(peerName);
	// the peer's card must replicate from staging before the row exists
	const row = page.locator('._user').filter({ hasText: peerName }).first();
	await expect(row).toBeVisible({ timeout: 90_000 });
	await row.click();
	await expect(page.locator('.chat-window')).toBeVisible();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	await page.getByPlaceholder('Type a message...').fill(text);
	await page.getByPlaceholder('Type a message...').press('Enter');
	// optimistic bubble appears immediately
	await expect(page.locator('.message-bubble').filter({ hasText: text }).first()).toBeVisible();
}

export interface Account { page: Page; name: string }

/**
 * Two independent browser contexts with fresh accounts — separate storage,
 * separate vaults, talking only through the staging backend.
 *
 * Worker-scoped and created concurrently: account creation is the expensive
 * part (~80s each against staging), so one pair serves every test in the
 * worker, and tests get dialogs with real history instead of a cold start.
 */
export const test = base.extend<Record<never, never>, { pair: { alice: Account; bob: Account } }>({
	pair: [async ({ browser }, use) => {
		const make = async (role: string) => {
			const context = await browser.newContext();
			const page = await context.newPage();
			const name = await createAccount(context, page, role);
			return { context, page, name };
		};
		const [a, b] = await Promise.all([make('alice'), make('bob')]);
		await use({ alice: { page: a.page, name: a.name }, bob: { page: b.page, name: b.name } });
		await a.context.close();
		await b.context.close();
	}, { scope: 'worker', timeout: 300_000 }],
});
