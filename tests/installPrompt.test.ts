// @vitest-environment jsdom
// The browser's install offer is kept for the menu and used once; Safari on
// iOS, which makes no offer, gets the manual route instead.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listenForInstallPrompt, useInstallPrompt, _resetInstallPromptForTests } from '@/composables/useInstallPrompt';

const offerEvent = (outcome: 'accepted' | 'dismissed') => {
	const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: string }>;
	};
	event.prompt = vi.fn(async () => {});
	event.userChoice = Promise.resolve({ outcome });
	return event;
};

const setUserAgent = (ua: string, maxTouchPoints = 0) => {
	Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
	Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
};

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';

let target: EventTarget;

beforeEach(() => {
	_resetInstallPromptForTests();
	target = new EventTarget();
	listenForInstallPrompt(target as unknown as Window);
	setUserAgent(CHROME_ANDROID);
});

describe('the browser install offer', () => {
	it('is kept from startup and opens the browser dialog once', async () => {
		const { canPrompt, install } = useInstallPrompt();
		expect(canPrompt.value).toBe(false);

		const event = offerEvent('accepted');
		target.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(canPrompt.value).toBe(true);

		await expect(install()).resolves.toBe(true);
		expect(event.prompt).toHaveBeenCalledTimes(1);
		expect(canPrompt.value).toBe(false);
		await expect(install()).resolves.toBe(false);
	});

	it('goes away once the app is installed', () => {
		const { canPrompt } = useInstallPrompt();
		target.dispatchEvent(offerEvent('accepted'));
		target.dispatchEvent(new Event('appinstalled'));
		expect(canPrompt.value).toBe(false);
	});
});

describe('Safari on iOS', () => {
	it('gets the manual route', () => {
		setUserAgent(SAFARI_IPHONE);
		expect(useInstallPrompt().needsManualInstall.value).toBe(true);
	});

	it('an iPad that reports a desktop Safari still does', () => {
		setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5);
		expect(useInstallPrompt().needsManualInstall.value).toBe(true);
	});

	it('another browser on iOS does not: only Safari installs there', () => {
		setUserAgent(CHROME_IPHONE);
		expect(useInstallPrompt().needsManualInstall.value).toBe(false);
	});

	it('Chrome on Android does not need it', () => {
		expect(useInstallPrompt().needsManualInstall.value).toBe(false);
	});
});
