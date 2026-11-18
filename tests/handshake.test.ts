// Frontend candidate selection and proof forwarding through the app API.
// PQ2 parsing, transcripts and signatures are tested in pq-library.
import { describe, it, expect, vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { encode } from '@buckitup/pq-client/handshake';
import { fromBase64 } from '@buckitup/pq-client/signature';
import { candidateSelector, expectedRelays, looksVirtual, selectAddresses } from '@/lib/data/handshakeAddresses';
import { decode as decodeQwbp, encode as encodeQwbp, type QWBPGatheredCandidate } from 'qwbp';
import { makeTestIdentity } from './helpers/signedFixtures';

const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const alice = makeTestIdentity(7, 'Alice');

describe('the addresses a code offers (§5a)', () => {
	const at = (ip: string, type: QWBPGatheredCandidate['type'], protocol: 'udp' | 'tcp' = 'udp'): QWBPGatheredCandidate => ({ ip, port: 50000, type, protocol });
	const relays = [at('203.0.113.1', 'relay'), at('203.0.113.2', 'relay'), at('203.0.113.3', 'relay'), at('203.0.113.9', 'relay', 'tcp')];
	const gathered = [
		at('192.168.1.5', 'host'), at('192.168.1.5', 'host', 'tcp'), at('198.51.100.7', 'srflx'), at('198.51.100.8', 'srflx'),
		at('fd00::1', 'host'), at('fd00::2', 'host'), at('fd00::3', 'host'), at('10.0.0.5', 'host'), at('100.64.0.9', 'prflx'),
	];
	const described = (offered: ReturnType<typeof selectAddresses>) => offered.map((o) => `${o.kind}/${o.candidate.type}/${o.candidate.ip}`);

	it('puts the relay first (two at most, typed as srflx), then one STUN-found address, then the phone\'s own: UDP only, six at most, two IPv6 at most', () => {
		const offered = selectAddresses([...gathered, ...relays]);
		expect(described(offered)).toEqual([
			'relay/srflx/203.0.113.1', 'relay/srflx/203.0.113.2', 'srflx/srflx/198.51.100.7', 'host/host/192.168.1.5', 'host/host/fd00::1', 'host/host/fd00::2',
		]);
		expect(offered.every((o) => o.candidate.protocol === 'udp')).toBe(true);
	});

	it('leaves mDNS names out: 19 bytes each, and of no use across networks — the bound of six and the size of C hold', () => {
		const mdns = [at('0f4ac2b1-6c41-4a5e-9a1e-2b9a6e1d7c11.local', 'host'), at('1a2b3c4d-1111-2222-3333-444455556666.local', 'host')];
		const offered = selectAddresses([...mdns, ...gathered, ...relays]);
		expect(offered.some((o) => o.candidate.ip.endsWith('.local'))).toBe(false);
		const payload = encodeQwbp(fill(32, 5), offered.map((o) => o.candidate));
		expect(payload.length).toBe(34 + 4 * 7 + 2 * 19);
		expect(selectAddresses(mdns)).toEqual([]);
	});

	it('without a relay offers the phone\'s own addresses, and never a TCP one', () => {
		expect(described(selectAddresses(gathered.filter((c) => c.type === 'host')))).toEqual([
			'host/host/192.168.1.5', 'host/host/fd00::1', 'host/host/fd00::2', 'host/host/10.0.0.5',
		]);
	});

	it('offers the network the phone can reach before the computer\'s virtual ones', () => {
		// A Mac running OrbStack, as gathered: its Wi-Fi address comes last.
		const mac = ['192.168.139.3', '192.168.107.0', '192.168.117.0', '192.168.148.0', '192.168.155.0', '192.168.215.0', '172.17.0.1', '192.168.1.103']
			.map((ip) => at(ip, 'host'));
		expect(described(selectAddresses(mac))[0]).toBe('host/host/192.168.1.103');
		expect(['10.0.0.5', '192.168.1.5', '172.32.0.1', 'fd00::1'].filter(looksVirtual)).toEqual([]);
	});

	it('the relay alone, under the test switch', () => {
		expect(selectAddresses([...gathered, ...relays], { relayOnly: true }).map((o) => o.kind)).toEqual(['relay', 'relay']);
	});

	it('the code carries them: QWBP encodes a relay address as srflx, and C stays within the size the spec gives', () => {
		const offered = selectAddresses([...gathered, ...relays]).map((o) => o.candidate);
		const payload = encodeQwbp(fill(32, 5), offered);
		expect(decodeQwbp(payload).candidates.map((c) => `${c.type}/${c.ip}`)).toEqual([
			'srflx/203.0.113.1', 'srflx/203.0.113.2', 'srflx/198.51.100.7', 'host/192.168.1.5', 'host/fd00::1', 'host/fd00::2',
		]);
		expect(payload.length).toBe(34 + 4 * 7 + 2 * 19);
		expect(encode({ kind: 'C', sig: fill(64, 1), qwbp: payload }).length).toBeLessThanOrEqual(230);
	});

	it('the hook waits for the expected relays and a STUN-found address, and gives what it has when asked for the final list', () => {
		const select = candidateSelector({ relays: 2 });
		const host = [at('192.168.1.5', 'host')];
		expect(select(host, false)).toBeNull();
		expect(select([...host, relays[0], at('198.51.100.7', 'srflx')], false)).toBeNull();
		expect(select([...host, relays[0], relays[1], at('198.51.100.7', 'srflx')], false)).toHaveLength(4);
		expect(select([...host, relays[0]], true)?.map((c) => c.ip)).toEqual(['203.0.113.1', '192.168.1.5']);
		// With no relay, the list is the one at the end of gathering.
		expect(candidateSelector({ relays: 0 })(host, false)).toBeNull();
		expect(candidateSelector({ relays: 0 })(host, true)).toEqual([{ ip: '192.168.1.5', port: 50000, type: 'host', protocol: 'udp' }]);
		expect(candidateSelector({ relays: 0 })([], true)).toEqual([]);
	});

	it('counts one relay address per TURN URI, two at most', () => {
		expect(expectedRelays([])).toBe(0);
		expect(expectedRelays([{ urls: ['turn:r:3478?transport=udp', 'turn:r:3478?transport=tcp', 'turns:r:5349'], username: 'u', credential: 'c' }])).toBe(2);
		expect(expectedRelays([{ urls: 'turn:r:3478' }])).toBe(1);
	});
});

describe('the frontend ingest challenge proof', () => {
	it('is what ingest sends', async () => {
		const challenge = 'ingest-challenge ✓';
		const bodies: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
			if (url.endsWith('/challenge')) return new Response(JSON.stringify({ challenge_id: 'c9', challenge }));
			bodies.push(String(init?.body));
			return new Response('{}');
		});
		try {
			const { api } = await import('@/api/client');
			await api.ingestWithAuthEach([], alice.signSkey);
		} finally {
			vi.unstubAllGlobals();
		}
		const { auth } = JSON.parse(bodies[0]);
		expect(auth.challenge_id).toBe('c9');
		expect(ml_dsa87.verify(fromBase64(auth.signature), new TextEncoder().encode(challenge), fromBase64(alice.card.sign_pkey as string))).toBe(true);
	});
});
