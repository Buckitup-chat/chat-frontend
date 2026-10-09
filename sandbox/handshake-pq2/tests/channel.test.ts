import { describe, expect, it } from 'vitest';
import { linkOf, selectAddresses } from '../src/channel';

describe('the data channel link', () => {
	it('keeps a message that arrives before anyone listens, and hands it over in order', () => {
		const channel = { onmessage: null as ((e: MessageEvent) => void) | null, send: () => {} };
		const link = linkOf(channel as unknown as RTCDataChannel);
		channel.onmessage!({ data: 'first' } as MessageEvent);
		channel.onmessage!({ data: 'second' } as MessageEvent);
		const got: string[] = [];
		link.onMessage((text) => got.push(text));
		channel.onmessage!({ data: 'third' } as MessageEvent);
		expect(got).toEqual(['first', 'second', 'third']);
	});
});

describe('the addresses a code offers', () => {
	const at = (ip: string, type: 'host' | 'srflx', protocol: 'udp' | 'tcp' = 'udp') => ({ ip, port: 50000, type, protocol }) as const;
	const relays = [at('203.0.113.1', 'srflx'), at('203.0.113.2', 'srflx'), at('203.0.113.3', 'srflx')];
	const gathered = [
		at('192.168.1.5', 'host'), at('192.168.1.5', 'host', 'tcp'), at('198.51.100.7', 'srflx'), at('198.51.100.8', 'srflx'),
		at('fd00::1', 'host'), at('fd00::2', 'host'), at('fd00::3', 'host'), at('10.0.0.5', 'host'),
	];

	it('puts the relay first (two at most), then one STUN-found address, then the phone\'s own, UDP only, six at most, two IPv6 at most', () => {
		const offered = selectAddresses(relays, gathered, false);
		expect(offered.map((o) => `${o.kind}/${o.c.ip}`)).toEqual([
			'relay/203.0.113.1', 'relay/203.0.113.2', 'srflx/198.51.100.7', 'host/192.168.1.5', 'host/fd00::1', 'host/fd00::2',
		]);
		expect(offered.every((o) => o.c.protocol === 'udp')).toBe(true);
	});

	it('offers the relay alone when asked to', () => {
		expect(selectAddresses(relays, gathered, true).map((o) => o.kind)).toEqual(['relay', 'relay']);
	});
});
