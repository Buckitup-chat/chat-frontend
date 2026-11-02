import { describe, it, expect } from 'vitest';
import { describeThisDevice } from '../src/lib/thisDevice';

const UA = {
	iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
	macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
	macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
	androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
	linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

describe('describeThisDevice', () => {
	it('names the device and the browser from the user agent', () => {
		expect(describeThisDevice(UA.iphoneSafari, 5)).toEqual({ name: 'iPhone', browser: 'Safari', kind: 'phone' });
		expect(describeThisDevice(UA.iphoneChrome, 5)).toEqual({ name: 'iPhone', browser: 'Chrome', kind: 'phone' });
		expect(describeThisDevice(UA.macChrome, 0)).toEqual({ name: 'Mac', browser: 'Chrome', kind: 'computer' });
		expect(describeThisDevice(UA.windowsEdge, 0)).toEqual({ name: 'Windows', browser: 'Edge', kind: 'computer' });
		expect(describeThisDevice(UA.androidChrome, 5)).toEqual({ name: 'Android', browser: 'Chrome', kind: 'phone' });
		expect(describeThisDevice(UA.linuxFirefox, 0)).toEqual({ name: 'Linux', browser: 'Firefox', kind: 'computer' });
	});

	it('tells an iPad on a desktop user agent from a Mac by its touch points', () => {
		expect(describeThisDevice(UA.macSafari, 0).name).toBe('Mac');
		expect(describeThisDevice(UA.macSafari, 5).name).toBe('iPad');
	});

	it('falls back to generic words for an unknown agent', () => {
		expect(describeThisDevice('curl/8.0', 0)).toEqual({ name: 'This device', browser: 'Browser', kind: 'computer' });
	});
});
