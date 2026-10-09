// Channel adapters for the engine: QWBP over WebRTC in the browser, and a
// fake network for the tests.
import { MIN_PACKET_SIZE, QWBPConnection, decode, encode, type QWBPCandidate } from 'qwbp';
import { concatBytes, randomBytes } from '@noble/hashes/utils';
import { equalBytes } from '@noble/post-quantum/utils.js';
import type { ChannelAdapter, ChannelLink } from './engine';

/** Messages that arrive before the engine listens are kept for it: the peer may confirm the moment the channel opens. */
export const linkOf = (channel: Pick<RTCDataChannel, 'send' | 'onmessage'>): ChannelLink => {
	const early: string[] = [];
	let handler: ((text: string) => void) | null = null;
	channel.onmessage = (event) => {
		const text = String(event.data);
		if (handler) handler(text);
		else early.push(text);
	};
	return {
		send: (text) => channel.send(text),
		onMessage: (h) => {
			handler = h;
			for (const text of early.splice(0)) h(text);
		},
	};
};

/**
 * Addresses a code offers. QWBP's own cut, the first 4, can be all virtual
 * networks on a computer running VMs or containers; more makes C and D denser,
 * and B is already at the limit of what a camera reads.
 */
const MAX_ADDRESSES = 6;
/** An IPv6 address takes 19 bytes in the code against IPv4's 7; two keep C and D below B's density. */
const MAX_IPV6 = 2;

type Offered = { c: QWBPCandidate; kind: 'relay' | 'srflx' | 'host' };

/**
 * What a code offers (spec §5a): UDP only, relay addresses first (at most two),
 * then one STUN-found address, then the phone's own — at most six, at most two
 * of them IPv6. Relay addresses arrive already typed as srflx (`relaysOf`).
 */
export const selectAddresses = (relays: QWBPCandidate[], gathered: QWBPCandidate[], relayOnly: boolean): Offered[] => {
	const udp = gathered.filter((c) => c.protocol === 'udp');
	let ipv6 = 0;
	return [
		...relays.slice(0, 2).map((c) => ({ c, kind: 'relay' as const })),
		...(relayOnly ? [] : [
			...udp.filter((c) => c.type === 'srflx').slice(0, 1).map((c) => ({ c, kind: 'srflx' as const })),
			...udp.filter((c) => c.type === 'host').map((c) => ({ c, kind: 'host' as const })),
		]),
	]
		.filter((o) => !o.c.ip.includes(':') || ++ipv6 <= MAX_IPV6)
		.slice(0, MAX_ADDRESSES);
};

const candidatesOf = (payload: Uint8Array) =>
	decode(payload).candidates.map((c) => `${c.type}/${c.ip}`).join(', ');

/**
 * The relay (TURN) addresses in an SDP. QWBP's own list leaves relay
 * candidates out and its format has no type for them; they go in as srflx,
 * as all the other phone needs of one is where to send.
 */
const relaysOf = (sdp: string): QWBPCandidate[] =>
	sdp.split('\n').flatMap((line) => {
		const m = line.match(/^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ relay/i);
		return m ? [{ ip: m[1], port: Number(m[2]), type: 'srflx' as const, protocol: 'udp' as const }] : [];
	});

export class QwbpChannel implements ChannelAdapter {
	private readonly conn: QWBPConnection;
	private own: Promise<Uint8Array> | null = null;

	/** relayOnly: offer only the relay server's addresses, so that whatever connects goes through it. */
	constructor(
		iceServers: RTCIceServer[],
		private readonly log: (line: string) => void,
		private readonly relayOnly = false,
	) {
		this.conn = new QWBPConnection({
			// An empty list means host candidates only: the phones must share a network.
			iceServers,
			// All of them: payload() chooses what the code offers.
			maxCandidates: 64,
			// Longer than any session (90 s, then 15 s for the channel); the engine closes it first.
			timeout: 3 * 60_000,
			onError: (e) => log(`channel: ${e.message}`),
		});
	}

	payload(): Promise<Uint8Array> {
		this.own ??= this.conn.initialize().then(() => {
			const all = this.conn.getQRPayload();
			// Without a single address the payload is not even a QWBP packet, and nothing could reach this phone.
			if (all.length < MIN_PACKET_SIZE) throw new Error('this phone has no network address to offer (airplane mode?)');
			// QWBP keeps relay addresses out of its own list; they are read from the
			// description here. The app gets them from a hook in QWBP instead (spec §5a).
			const { fingerprint, candidates } = decode(all);
			const sdp = (this.conn as unknown as { pc: RTCPeerConnection | null }).pc?.localDescription?.sdp ?? '';
			const offered = selectAddresses(relaysOf(sdp), candidates, this.relayOnly);
			if (!offered.length) {
				throw new Error(this.relayOnly ? 'the relay server gave this phone no address (check the TURN settings)' : 'this phone has no UDP address to offer');
			}
			const payload = encode(fingerprint, offered.map((o) => o.c));
			this.log(`own payload ${payload.length} B, offered: ${offered.map((o) => `${o.kind}/${o.c.ip}`).join(', ')}`);
			return payload;
		});
		return this.own;
	}

	async feed(peerPayload: Uint8Array): Promise<void> {
		await this.payload();
		this.log(`peer candidates: ${candidatesOf(peerPayload)}`);
		await this.conn.processScannedPayload(peerPayload);
	}

	onOpen(handler: (link: ChannelLink) => void): void {
		// QWBP calls back with open channels only. The answerer is also handed
		// the 'init' channel, which served only to start the gathering.
		this.conn.onDataChannel((channel) => {
			if (channel.label === 'qwbp') handler(linkOf(channel));
		});
	}

	fingerprintOf(payload: Uint8Array): Uint8Array {
		return decode(payload).fingerprint;
	}

	close(): void {
		this.conn.close();
		// close() cannot stop a setup already under way; close again once it is done.
		const again = () => this.conn.close();
		this.own?.then(again, again);
	}
}

// ---------- the fake network (tests) ----------

/**
 * Channels that behave like QWBP's where the engine can tell: a payload only
 * once the connection is set up (never, for a phone with no address), one
 * peer per connection, and a channel that opens a network turn after both
 * sides have been fed each other's payload — or never, when `reachable` is
 * false (phones on different networks). A message sent before the other side
 * listens is lost. A payload is the fingerprint (32 bytes) plus 8 bytes of noise.
 */
export class FakeNetwork {
	reachable = true;
	/** How long a message takes over an open channel. */
	latencyMs = 0;
	readonly channels: FakeChannel[] = [];

	channel = ({ address = true } = {}): FakeChannel => {
		const ch = new FakeChannel(this, address);
		this.channels.push(ch);
		return ch;
	};

	fed(a: FakeChannel): void {
		const b = this.channels.find((c) => a.peerFingerprint && equalBytes(c.fingerprint, a.peerFingerprint));
		if (!b?.peerFingerprint || !this.reachable || !equalBytes(b.peerFingerprint, a.fingerprint)) return;
		const [la, lb] = this.pipe();
		setTimeout(() => {
			a.opened(la);
			b.opened(lb);
		}, 0);
	}

	private pipe(): [ChannelLink, ChannelLink] {
		// Like linkOf: a message sent before the other end listens waits for it.
		const handlers: [((t: string) => void) | null, ((t: string) => void) | null] = [null, null];
		const early: [string[], string[]] = [[], []];
		const deliver = (to: 0 | 1, text: string) => (handlers[to] ? handlers[to]!(text) : early[to].push(text));
		const end = (me: 0 | 1): ChannelLink => ({
			send: (text) => setTimeout(() => deliver(me === 0 ? 1 : 0, text), this.latencyMs),
			onMessage: (h) => {
				handlers[me] = h;
				for (const text of early[me].splice(0)) h(text);
			},
		});
		return [end(0), end(1)];
	}
}

export class FakeChannel implements ChannelAdapter {
	readonly fingerprint = randomBytes(32);
	peerFingerprint: Uint8Array | null = null;
	closed = false;
	private handler: ((link: ChannelLink) => void) | null = null;
	private readonly own: Promise<Uint8Array>;

	constructor(private readonly net: FakeNetwork, address: boolean) {
		this.own = address
			? Promise.resolve(concatBytes(this.fingerprint, randomBytes(8)))
			: Promise.reject(new Error('this phone has no network address to offer'));
		this.own.catch(() => {});
	}

	payload(): Promise<Uint8Array> {
		return this.own;
	}

	async feed(peerPayload: Uint8Array): Promise<void> {
		await this.own;
		if (this.closed) throw new Error('Cannot process payload in state: closed');
		if (this.peerFingerprint) throw new Error('Peer already scanned');
		this.peerFingerprint = peerPayload.slice(0, 32);
		this.net.fed(this);
	}

	onOpen(handler: (link: ChannelLink) => void): void {
		this.handler = handler;
	}

	opened(link: ChannelLink): void {
		if (!this.closed) this.handler?.(link);
	}

	fingerprintOf(payload: Uint8Array): Uint8Array {
		return payload.slice(0, 32);
	}

	close(): void {
		this.closed = true;
	}
}
