// Channel adapters for the engine: QWBP over WebRTC in the browser, and a
// fake network for the tests.
import { MIN_PACKET_SIZE, QWBPConnection, decode } from 'qwbp';
import { concatBytes, randomBytes } from '@noble/hashes/utils';
import { equalBytes } from '@noble/post-quantum/utils.js';
import type { ChannelAdapter, ChannelLink } from './engine';

const linkOf = (channel: RTCDataChannel): ChannelLink => ({
	send: (text) => channel.send(text),
	onMessage: (handler) => {
		channel.onmessage = (event) => handler(String(event.data));
	},
});

const candidatesOf = (payload: Uint8Array) =>
	decode(payload).candidates.map((c) => `${c.type}/${c.ip}`).join(', ');

export class QwbpChannel implements ChannelAdapter {
	private readonly conn: QWBPConnection;
	private own: Promise<Uint8Array> | null = null;

	constructor(iceServers: RTCIceServer[], private readonly log: (line: string) => void) {
		this.conn = new QWBPConnection({
			// An empty list means host candidates only: the phones must share a network.
			iceServers,
			// QWBP's default of 4 addresses can be all virtual ones on a computer
			// running VMs or containers, leaving out the one the phone can reach.
			maxCandidates: 8,
			// The engine's deadlines end every session long before, and close the connection.
			timeout: 60 * 60_000,
			onError: (e) => log(`channel: ${e.message}`),
		});
	}

	payload(): Promise<Uint8Array> {
		this.own ??= this.conn.initialize().then(() => {
			const payload = this.conn.getQRPayload();
			// Without a single address the payload is not even a QWBP packet, and nothing could reach this phone.
			if (payload.length < MIN_PACKET_SIZE) throw new Error('this phone has no network address to offer (airplane mode?)');
			this.log(`own payload ${payload.length} B, candidates: ${candidatesOf(payload)}`);
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
		const handlers: [((t: string) => void) | null, ((t: string) => void) | null] = [null, null];
		const end = (me: 0 | 1): ChannelLink => ({
			send: (text) => setTimeout(() => handlers[me === 0 ? 1 : 0]?.(text), this.latencyMs),
			onMessage: (h) => {
				handlers[me] = h;
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
