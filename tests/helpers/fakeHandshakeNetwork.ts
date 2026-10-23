// A fake network for the handshake engine, and test identities for it.
//
// The channels behave like QWBP's where the engine can tell: a payload only
// once the connection is set up (never, for a phone with no address), one
// peer per connection, and a channel that opens a network turn after both
// sides have been fed each other's payload — or never, when `reachable` is
// false (phones on different networks). A message sent before the other end
// listens waits for it, as on a real data channel (linkOf). A payload is a
// real QWBP packet: the engine takes its fingerprint with QWBP's own parser.
import { randomBytes } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { decode, encode } from 'qwbp';
import { equalBytes } from '@noble/post-quantum/utils.js';
import { fromBase64 } from '@/lib/pq/signature';
import { signOptical } from '@/lib/pq/handshake';
import type { ChannelAdapter, ChannelLink, HandshakeIdentity } from '@/lib/handshake/engine';
import type { UserCardRow } from '@/lib/data/types';
import type { TestIdentity } from './signedFixtures';

/** The engine's view of a test account: its keys sign, its card is the one it publishes. */
export const handshakeIdentity = (id: TestIdentity, overrides: Partial<HandshakeIdentity> = {}): HandshakeIdentity => ({
	userHash: id.userHash,
	contactPkey: fromBase64(id.card.contact_pkey as string),
	signOptical: (T) => signOptical(T, id.contactSk),
	signPq: async (M) => ml_dsa87.sign(M, id.signSkey),
	signedCard: async () => id.card as UserCardRow,
	...overrides,
});

/** Someone showing `victim`'s user_hash with their own key, and sending the victim's card. */
export const impostorIdentity = (self: TestIdentity, victim: TestIdentity): HandshakeIdentity => ({
	...handshakeIdentity(self),
	userHash: victim.userHash,
	signedCard: async () => victim.card as UserCardRow,
});

export class FakeNetwork {
	reachable = true;
	/** How long a message takes over an open channel. */
	latencyMs = 0;
	/** How long a channel takes to open once both sides were fed. */
	openAfterMs = 0;
	/** Data channels each connection hands over when it opens: QWBP can hand over two. */
	channelsPerOpen = 1;
	readonly channels: FakeChannel[] = [];

	channel = ({ address = true } = {}): FakeChannel => {
		const ch = new FakeChannel(this, address);
		this.channels.push(ch);
		return ch;
	};

	fed(a: FakeChannel): void {
		const b = this.channels.find((c) => a.peerFingerprint && equalBytes(c.fingerprint, a.peerFingerprint));
		if (!b?.peerFingerprint || !this.reachable || !equalBytes(b.peerFingerprint, a.fingerprint)) return;
		setTimeout(() => {
			for (let i = 0; i < this.channelsPerOpen; i++) {
				const [la, lb] = this.pipe();
				a.opened(la);
				b.opened(lb);
			}
		}, this.openAfterMs);
	}

	private pipe(): [ChannelLink, ChannelLink] {
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

let port = 40000;

export class FakeChannel implements ChannelAdapter {
	readonly fingerprint = randomBytes(32);
	peerFingerprint: Uint8Array | null = null;
	closed = false;
	/** Messages this side sent, over any of its links. */
	readonly sent: string[] = [];
	private handler: ((link: ChannelLink) => void) | null = null;
	private readonly own: Promise<Uint8Array>;

	constructor(private readonly net: FakeNetwork, address: boolean) {
		this.own = address
			? Promise.resolve(encode(this.fingerprint, [{ ip: '192.0.2.10', port: port++, type: 'host', protocol: 'udp' }]))
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
		this.peerFingerprint = decode(peerPayload).fingerprint;
		this.net.fed(this);
	}

	onOpen(handler: (link: ChannelLink) => void): void {
		this.handler = handler;
	}

	opened(link: ChannelLink): void {
		if (this.closed) return;
		const counted: ChannelLink = {
			send: (text) => {
				this.sent.push(text);
				link.send(text);
			},
			onMessage: (h) => link.onMessage(h),
		};
		this.handler?.(counted);
	}

	close(): void {
		this.closed = true;
	}
}
