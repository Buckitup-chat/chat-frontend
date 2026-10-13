// The engine's channel in the browser: one QWBP connection per session
// (docs/task-handshake-pq2.md §5a), created at the session's start with the
// relay as its only ICE server, or with none.
/* global RTCIceServer -- a DOM type */
import { MIN_PACKET_SIZE, QWBPConnection, decode } from 'qwbp';
import { candidateSelector, expectedRelays, MAX_ADDRESSES, type OfferedAddress } from '@/lib/data/handshakeAddresses';
import type { ChannelAdapter, ChannelLink } from './engine';

/** Longer than any session (90 s, then 15 s for the channel and 10 s for the confirmation); the engine closes it first. */
export const QWBP_TIMEOUT_MS = 3 * 60_000;

/**
 * A test switch for the Chromium check (scripts/handshake-check): offer the
 * relay's addresses alone, so that two pages on one host connect through it.
 * Only a build in that mode has it; in the app's build the branch is dead code.
 */
const RELAY_ONLY_ALLOWED = import.meta.env.MODE === 'handshake-check';

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

const described = (offered: OfferedAddress[]) => offered.map((o) => `${o.kind}/${o.candidate.ip}`).join(', ') || 'none';

export interface QwbpChannelOptions {
	/** The relay, or `[]`; a promise, so that the code shows while the credentials are fetched. */
	iceServers: RTCIceServer[] | Promise<RTCIceServer[]>;
	log?: (line: string) => void;
	/** Test switch, see RELAY_ONLY_ALLOWED. */
	relayOnly?: boolean;
}

export class QwbpChannel implements ChannelAdapter {
	private conn: QWBPConnection | null = null;
	private own: Promise<Uint8Array> | null = null;
	private handler: ((link: ChannelLink) => void) | null = null;
	private closed = false;

	constructor(private readonly options: QwbpChannelOptions) {}

	private log(line: string): void {
		this.options.log?.(line);
	}

	payload(): Promise<Uint8Array> {
		this.own ??= this.connect();
		return this.own;
	}

	private async connect(): Promise<Uint8Array> {
		const iceServers = await this.options.iceServers;
		if (this.closed) throw new Error('the session ended');
		const relayOnly = RELAY_ONLY_ALLOWED && !!this.options.relayOnly;
		const conn = new QWBPConnection({
			// Always explicit: QWBP falls back to Google's STUN servers when the option is missing.
			iceServers,
			maxCandidates: MAX_ADDRESSES,
			// QWBP's 30 s default would close the connection while the codes are still being read.
			timeout: QWBP_TIMEOUT_MS,
			selectCandidates: candidateSelector({
				relays: expectedRelays(iceServers),
				relayOnly,
				onSelected: (offered) => this.log(`offered: ${described(offered)}`),
			}),
			onError: (e) => this.log(`channel: ${e.message}`),
		});
		this.conn = conn;
		this.log(iceServers.length ? 'connection with the relay' : 'connection without a relay: own addresses only');
		// QWBP calls back with open channels only. The answerer is also handed
		// the offerer's 'init' channel, which served only to start gathering.
		conn.onDataChannel((channel) => {
			if (channel.label === 'qwbp') this.handler?.(linkOf(channel));
		});
		await conn.initialize();
		if (this.closed) throw new Error('the session ended');
		const payload = conn.getQRPayload();
		// Without a single address the payload is not even a QWBP packet, and nothing could reach this phone.
		if (payload.length < MIN_PACKET_SIZE) {
			throw new Error(relayOnly ? 'the relay gave this phone no address' : 'this phone has no network address to offer');
		}
		return payload;
	}

	async feed(peerPayload: Uint8Array): Promise<void> {
		await this.payload();
		this.log(`peer candidates: ${decode(peerPayload).candidates.map((c) => `${c.type}/${c.ip}`).join(', ')}`);
		await this.conn!.processScannedPayload(peerPayload);
	}

	onOpen(handler: (link: ChannelLink) => void): void {
		this.handler = handler;
	}

	close(): void {
		this.closed = true;
		this.conn?.close();
		// close() cannot stop a setup already under way; close again once it is done.
		const again = () => this.conn?.close();
		this.own?.then(again, again);
	}
}
