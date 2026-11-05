// Installing the app to the home screen or desktop.
//
// Chromium browsers offer installation through `beforeinstallprompt`, fired
// once, early; the event is kept so the Install app screen can open the
// browser's own install dialog later. Safari on iOS has no such event: there
// it is Share → Add to Home Screen. Installing matters most there — Safari
// clears a site's storage after seven days without a visit, and an installed
// app's it keeps. The installed app opens at the build base, inside the
// service worker's scope, so it starts with no network.
import { computed, ref } from 'vue';
import { describeThisDevice } from '@/lib/thisDevice';

interface InstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const offer = ref<InstallPromptEvent | null>(null);
const installed = ref(false);
const installing = ref(false);

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

/**
 * How this browser installs the app:
 * - `installed`: it is, and this may be it;
 * - `prompt`: the browser's own dialog, from a button;
 * - `ios`: Share → Add to Home Screen, in Safari and, since iOS 16.4, in
 *   the other browsers there;
 * - `menu`: an item in the browser's menu. Chromium makes its offer only once
 *   its criteria are met and makes none while the app is installed; Android
 *   browsers and Safari on a Mac (File → Add to Dock) have the item anyway;
 * - `unsupported`: Firefox on a computer.
 */
export type InstallMode = 'installed' | 'prompt' | 'ios' | 'menu' | 'unsupported';

export const installModeOf = (
	{ inApp, installed, offered, ua, touchPoints }: { inApp: boolean; installed: boolean; offered: boolean; ua: string; touchPoints: number },
): InstallMode => {
	if (inApp || installed) return 'installed';
	if (offered) return 'prompt';
	const device = describeThisDevice(ua, touchPoints);
	if (device.ios) return 'ios';
	if (/Android/.test(ua) || /Chrome\/|Edg\//.test(ua) || (/Version\/[\d.]+ Safari/.test(ua) && !/Firefox/.test(ua))) return 'menu';
	return 'unsupported';
};

export function useInstallPrompt() {
	const inApp = runningInstalled();
	const mode = computed(() => installModeOf({
		inApp, installed: installed.value, offered: offer.value !== null,
		ua: navigator.userAgent, touchPoints: navigator.maxTouchPoints ?? 0,
	}));

	/** Opens the browser's install dialog; true once the user accepted it. */
	const install = async (): Promise<boolean> => {
		const event = offer.value;
		if (!event) return false;
		offer.value = null; // the browser honours one prompt per event
		installing.value = true;
		try {
			await event.prompt();
			const accepted = (await event.userChoice).outcome === 'accepted';
			if (accepted) installed.value = true;
			return accepted;
		} finally {
			installing.value = false;
		}
	};

	return { inApp, mode, installing, install };
}

export function _resetInstallPromptForTests(): void {
	offer.value = null;
	installed.value = false;
	installing.value = false;
}
