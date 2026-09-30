// Channel adapters for the engine: QWBP over WebRTC in the browser, and a
// fake network for the tests.
import { QWBPConnection, decode } from 'qwbp';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';
import type { ChannelAdapter, ChannelLink } from './engine';

/** ICE servers for the "STUN on" setting: reach across networks, at the price of asking a third party. */
export const PUBLIC_STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

const linkOf = (channel: RTCDataChannel): ChannelLink => ({
	send: (text) => channel.send(text),
	onMessage: (handler) => {
		channel.onmessage = (event) => handler(String(event.data));
	},
	close: () => channel.close(),
});

export class QwbpChannel implements ChannelAdapter {
	private readonly conn: QWBPConnection;
	private ready: Promise<void> | null = null;
	private own: Uint8Array | null = null;

	constructor(iceServers: RTCIceServer[], private readonly log: (line: string) => void = () => {}) {
		// An empty list means host candidates only: the phones must share a network.
		this.conn = new QWBPConnection({ iceServers, timeout: 60_000 });
	}

	private init(): Promise<void> {
		this.ready ??= this.conn.initialize();
		return this.ready;
	}

	async payload(): Promise<Uint8Array> {
		await this.init();
		if (!this.own) {
			this.own = this.conn.getQRPayload();
			const { candidates } = decode(this.own);
			this.log(`own payload ${this.own.length} B, candidates: ${candidates.map((c) => `${c.type}/${c.ip}`).join(', ') || 'none'}`);
		}
		return this.own;
	}

	async feed(peerPayload: Uint8Array): Promise<void> {
		await this.init();
		const { candidates } = decode(peerPayload);
		this.log(`peer candidates: ${candidates.map((c) => `${c.type}/${c.ip}`).join(', ') || 'none'}`);
		await this.conn.processScannedPayload(peerPayload);
	}

	onOpen(handler: (link: ChannelLink) => void): void {
		this.conn.onDataChannel((channel) => {
			if (channel.readyState === 'open') handler(linkOf(channel));
			else channel.addEventListener('open', () => handler(linkOf(channel)), { once: true });
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
 * Channels that join once each has been fed the other's payload, as QWBP
 * does — or never, when `reachable` is false (phones on different networks).
 * A payload is the channel's fingerprint (32 bytes) plus 8 bytes of noise.
 */
export class FakeNetwork {
	reachable = true;
	private readonly channels = new Map<string, FakeChannel>();

	channel = (): FakeChannel => {
		const ch = new FakeChannel(this);
		this.channels.set(bytesToHex(ch.fingerprint), ch);
		return ch;
	};

	fedEachOther(a: FakeChannel): void {
		const b = a.peerFingerprint && this.channels.get(bytesToHex(a.peerFingerprint));
		if (!b || !this.reachable || !b.peerFingerprint || bytesToHex(b.peerFingerprint) !== bytesToHex(a.fingerprint)) return;
		const [la, lb] = FakeChannel.pipe();
		queueMicrotask(() => {
			a.opened(la);
			b.opened(lb);
		});
	}
}

export class FakeChannel implements ChannelAdapter {
	readonly fingerprint = randomBytes(32);
	peerFingerprint: Uint8Array | null = null;
	private handler: ((link: ChannelLink) => void) | null = null;
	private closed = false;

	constructor(private readonly net: FakeNetwork) {}

	static pipe(): [ChannelLink, ChannelLink] {
		const handlers: [((t: string) => void) | null, ((t: string) => void) | null] = [null, null];
		const queued: [string[], string[]] = [[], []];
		const deliver = (to: 0 | 1, text: string) => {
			const h = handlers[to];
			if (h) setTimeout(() => h(text), 0);
			else queued[to].push(text);
		};
		const end = (me: 0 | 1): ChannelLink => ({
			send: (text) => deliver(me === 0 ? 1 : 0, text),
			onMessage: (h) => {
				handlers[me] = h;
				for (const text of queued[me].splice(0)) setTimeout(() => h(text), 0);
			},
			close: () => {},
		});
		return [end(0), end(1)];
	}

	async payload(): Promise<Uint8Array> {
		const out = new Uint8Array(40);
		out.set(this.fingerprint);
		out.set(randomBytes(8), 32);
		return out;
	}

	async feed(peerPayload: Uint8Array): Promise<void> {
		this.peerFingerprint = peerPayload.slice(0, 32);
		this.net.fedEachOther(this);
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
