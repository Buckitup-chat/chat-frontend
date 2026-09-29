// Installing the app to the home screen or desktop.
//
// Chromium browsers offer installation through `beforeinstallprompt`, fired
// once, early; the event is kept so the menu can open the browser's own
// install dialog later. Safari on iOS has no such event: there it is Share →
// Add to Home Screen. Installing matters most there — Safari clears a site's
// storage after seven days without a visit, and an installed app's it keeps.
// The installed app opens at the build base, inside the service worker's
// scope, so it starts with no network.
import { computed, ref } from 'vue';

interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const offer = ref<InstallPromptEvent | null>(null);
const installed = ref(false);

/** Keep the browser's install offer; call once at startup. */
export function listenForInstallPrompt(target: Window = window): void {
	target.addEventListener('beforeinstallprompt', (event) => {
		event.preventDefault();
		offer.value = event as InstallPromptEvent;
	});
	target.addEventListener('appinstalled', () => {
		offer.value = null;
		installed.value = true;
	});
}

const runningInstalled = (): boolean =>
	window.matchMedia?.('(display-mode: standalone)').matches === true
	|| (navigator as Navigator & { standalone?: boolean }).standalone === true;

const iosSafari = (): boolean => {
	const ua = navigator.userAgent;
	// iPadOS reports a desktop Safari; touch points tell it apart from a Mac.
	const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
};

export function useInstallPrompt() {
	const inApp = runningInstalled();
	/** The browser can install the app from a button. */
	const canPrompt = computed(() => !inApp && !installed.value && offer.value !== null);
	/** Safari on iOS: installation is manual, through the Share menu. */
	const needsManualInstall = computed(() => !inApp && !installed.value && offer.value === null && iosSafari());

	const install = async (): Promise<boolean> => {
		const event = offer.value;
		if (!event) return false;
		offer.value = null; // the browser honours one prompt per event
		await event.prompt();
		return (await event.userChoice).outcome === 'accepted';
	};

	return { canPrompt, needsManualInstall, install };
}

export function _resetInstallPromptForTests(): void {
	offer.value = null;
	installed.value = false;
}
