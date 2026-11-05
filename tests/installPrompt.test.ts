// @vitest-environment jsdom
// The browser's install offer is kept for the Install app screen and used
// once; a browser that makes no offer gets the route it has instead.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installModeOf, listenForInstallPrompt, useInstallPrompt, _resetInstallPromptForTests } from '@/composables/useInstallPrompt';

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
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0';
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
		const { mode, install } = useInstallPrompt();
		expect(mode.value).toBe('menu');

		const event = offerEvent('accepted');
		target.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(mode.value).toBe('prompt');

		await expect(install()).resolves.toBe(true);
		expect(event.prompt).toHaveBeenCalledTimes(1);
		expect(mode.value).toBe('installed');
		await expect(install()).resolves.toBe(false);
	});

	it('a dismissed dialog is not offered again: the menu is the way left', async () => {
		const { mode, install, installing } = useInstallPrompt();
		target.dispatchEvent(offerEvent('dismissed'));
		const done = install();
		expect(installing.value).toBe(true);
		await expect(done).resolves.toBe(false);
		expect(installing.value).toBe(false);
		expect(mode.value).toBe('menu');
	});

	it('goes away once the app is installed', () => {
		const { mode } = useInstallPrompt();
		target.dispatchEvent(offerEvent('accepted'));
		target.dispatchEvent(new Event('appinstalled'));
		expect(mode.value).toBe('installed');
	});
});

describe('the route a browser without an offer has', () => {
	const modeFor = (ua: string, touchPoints = 0) => installModeOf({ inApp: false, installed: false, offered: false, ua, touchPoints });

	it('Safari on iOS: the Share menu', () => {
		expect(modeFor(SAFARI_IPHONE)).toBe('ios');
	});

	it('an iPad that reports a desktop Safari: the Share menu too', () => {
		expect(modeFor(SAFARI_MAC, 5)).toBe('ios');
	});

	it('another browser on iOS: its Share menu too', () => {
		expect(modeFor(CHROME_IPHONE)).toBe('ios');
	});

	it('Chrome on Android, Chromium and Safari on a computer: the browser menu', () => {
		expect(modeFor(CHROME_ANDROID)).toBe('menu');
		expect(modeFor(CHROME_MAC)).toBe('menu');
		expect(modeFor(SAFARI_MAC)).toBe('menu');
	});

	it('Firefox on a computer: none', () => {
		expect(modeFor(FIREFOX_MAC)).toBe('unsupported');
	});

	it('the app itself: installed, whatever the browser', () => {
		expect(installModeOf({ inApp: true, installed: false, offered: false, ua: FIREFOX_MAC, touchPoints: 0 })).toBe('installed');
	});
});
