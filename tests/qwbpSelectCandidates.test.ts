// The QWBP patch (patches/qwbp+0.1.0.patch, docs/task-handshake-pq2.md §5a):
// the selectCandidates hook sees every gathered candidate, relay included,
// and the payload is yielded once its list is complete or after 2 s — not at
// the end of gathering, which one slow transport can hold up. Against a
// stubbed RTCPeerConnection that gathers on a schedule.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { QWBPConnection, decode } from 'qwbp';
import { candidateSelector } from '@/lib/data/handshakeAddresses';

type Gathering = Array<[ms: number, line: string | null]>;
let schedule: Gathering = [];
const made: StubPeerConnection[] = [];

class StubPeerConnection {
	static async generateCertificate() { return {}; }
	localDescription: { type: string; sdp: string } | null = null;
	iceGatheringState = 'new';
	onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null;
	onicegatheringstatechange: (() => void) | null = null;
	constructor(readonly configuration: RTCConfiguration) {
		made.push(this);
	}
	createDataChannel(label: string) { return { label, close() {} }; }
	async createOffer() {
		const fp = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join(':');
		return { type: 'offer', sdp: `v=0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${fp}\r\n` };
	}
	async setLocalDescription(d: { type: string; sdp: string }) {
		this.localDescription = d;
		for (const [ms, line] of schedule) {
			setTimeout(() => {
				if (line === null) {
					this.iceGatheringState = 'complete';
					this.onicegatheringstatechange?.();
					this.onicecandidate?.({ candidate: null });
				} else {
					this.onicecandidate?.({ candidate: { candidate: line } });
				}
			}, ms);
		}
	}
	close() {}
}

const host = 'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0';
const hostTcp = 'candidate:2 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active';
const srflx = 'candidate:3 1 udp 1686052607 198.51.100.7 61000 typ srflx raddr 192.168.1.20 rport 50000';
const relayUdp = 'candidate:4 1 udp 41885439 203.0.113.1 55000 typ relay raddr 198.51.100.7 rport 61000';
const relayTcp = 'candidate:5 1 udp 25108223 203.0.113.1 55002 typ relay raddr 198.51.100.7 rport 61002';

afterEach(() => {
	vi.unstubAllGlobals();
	made.length = 0;
});

const connect = async (relays: number, gathering: Gathering) => {
	schedule = gathering;
	vi.stubGlobal('RTCPeerConnection', StubPeerConnection);
	const conn = new QWBPConnection({ iceServers: [], maxCandidates: 6, timeout: 180_000, selectCandidates: candidateSelector({ relays }) });
	const started = Date.now();
	await conn.initialize();
	const elapsed = Date.now() - started;
	const payload = conn.getQRPayload();
	conn.close();
	const offered = payload.length > 34 ? decode(payload).candidates.map((c) => `${c.type}/${c.ip}:${c.port}`) : [];
	return { elapsed, offered, payload };
};

describe('QWBP\'s selectCandidates hook', () => {
	it('gets the relay candidates, and the payload once the list is complete — before gathering ends', async () => {
		const { elapsed, offered } = await connect(2, [[5, host], [6, hostTcp], [10, srflx], [40, relayUdp], [60, relayTcp], [5_000, null]]);
		expect(offered).toEqual(['srflx/203.0.113.1:55000', 'srflx/203.0.113.1:55002', 'srflx/198.51.100.7:61000', 'host/192.168.1.20:50000']);
		expect(elapsed).toBeLessThan(1_000);
	});

	it('gives the final list after 2 s when gathering is held up and the list is not complete', async () => {
		const { elapsed, offered } = await connect(2, [[5, host], [10, srflx], [40, relayUdp]]);
		expect(offered).toEqual(['srflx/203.0.113.1:55000', 'srflx/198.51.100.7:61000', 'host/192.168.1.20:50000']);
		expect(elapsed).toBeGreaterThanOrEqual(1_900);
		expect(elapsed).toBeLessThan(3_000);
	}, 10_000);

	it('with no relay, gives the list at the end of gathering', async () => {
		const { elapsed, offered } = await connect(0, [[5, host], [8, null]]);
		expect(offered).toEqual(['host/192.168.1.20:50000']);
		expect(elapsed).toBeLessThan(500);
	});

	it('with no address at all, ends at once with no candidate', async () => {
		const { elapsed, payload } = await connect(0, [[2, null]]);
		expect(payload.length).toBe(34);
		expect(elapsed).toBeLessThan(500);
	});
});
