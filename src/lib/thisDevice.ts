// What the Devices card calls the browser this page runs in: "iPhone" and
// "Safari". A user agent string is a hint, not a fact, so an unknown part
// falls back to a generic word rather than a guess.

export type DeviceKind = 'phone' | 'computer';

export interface ThisDevice {
	name: string;
	browser: string;
	kind: DeviceKind;
}

export function describeThisDevice(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): ThisDevice {
	// iPadOS reports a desktop Safari; touch points tell it apart from a Mac.
	const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
	const name = /iPhone/.test(ua) ? 'iPhone'
		: ipad ? 'iPad'
		: /Android/.test(ua) ? 'Android'
		: /Macintosh|Mac OS X/.test(ua) ? 'Mac'
		: /Windows/.test(ua) ? 'Windows'
		: /CrOS/.test(ua) ? 'Chromebook'
		: /Linux|X11/.test(ua) ? 'Linux'
		: 'This device';
	const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
		: /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
		: /Chrome\/|CriOS/.test(ua) ? 'Chrome'
		: /Safari\//.test(ua) ? 'Safari'
		: 'Browser';
	const kind: DeviceKind = /iPhone|Android.+Mobile/.test(ua) ? 'phone' : 'computer';
	return { name, browser, kind };
}
