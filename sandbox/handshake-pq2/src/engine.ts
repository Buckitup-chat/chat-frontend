// The PQ2 state machine (docs/task-handshake-pq2.md §5), without DOM or
// camera. The page feeds it the codes the camera reads and shows the codes it
// asks to show; the channel is an adapter — QWBP over WebRTC in the browser,
// a fake network in the tests.
import { bytesToHex } from '@noble/hashes/utils';
import type { UserCardRow } from '@/lib/data/types';
import type { Identity } from './identity';
import {
	checkConfirm, comparisonCode, confirmMessage, encode, newNonce, parse, pqMessage, signOptical, signPq,
	transcript, verifyOptical, type Message, type Party,
} from './protocol';

export interface ChannelLink {
	send(text: string): void;
	onMessage(handler: (text: string) => void): void;
	close(): void;
}

export interface ChannelAdapter {
	/** This side's bootstrap payload; sets the connection up on first call. */
	payload(): Promise<Uint8Array>;
	/** The peer's payload, as read from its code. */
	feed(peerPayload: Uint8Array): Promise<void>;
	onOpen(handler: (link: ChannelLink) => void): void;
	fingerprintOf(payload: Uint8Array): Uint8Array;
	close(): void;
}

export type Stage = 'idle' | 'A' | 'B' | 'C' | 'D' | 'done';

export type Outcome =
	| { kind: 'confirmed'; peerName: string; peerHash: string; code: string; card: UserCardRow }
	| { kind: 'verified'; peerHash: string; code: string | null; reason: string }
	| { kind: 'expired'; reason: string };

export interface Timings {
	[milestone: string]: number;
}

export interface EngineOptions {
	identity: Identity;
	channel: () => ChannelAdapter;
	/** Impersonation test: show this user_hash with our own contact key, and send this card. */
	claim?: { userHash: string; card: UserCardRow };
	sessionMs?: number;
	/** From both payloads known to the channel being open. */
	channelMs?: number;
	/** From the channel opening to the peer's confirmation. */
	confirmMs?: number;
	onShow(code: string, stage: Stage): void;
	onLog(line: string): void;
	/** Both payloads are known: nothing is left to read. */
	onReadingDone?(): void;
	onDone(outcome: Outcome, timings: Timings): void;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const short = (hash: string) => `${hash.slice(0, 10)}…`;

export class HandshakeEngine {
	private readonly o: Required<Omit<EngineOptions, 'claim' | 'onReadingDone'>> & Pick<EngineOptions, 'claim' | 'onReadingDone'>;
	private stage: Stage = 'idle';
	private me!: Party;
	private peer: Party | null = null;
	private T: Uint8Array | null = null;
	private mySig: Uint8Array | null = null;
	private conn: ChannelAdapter | null = null;
	private myPayload: Uint8Array | null = null;
	private peerPayload: Uint8Array | null = null;
	private code: string | null = null;
	private busy = false;
	private started = 0;
	private timings: Timings = {};
	private timers: ReturnType<typeof setTimeout>[] = [];
	private ignoredOwn = false;

	constructor(options: EngineOptions) {
		this.o = { sessionMs: 90_000, channelMs: 15_000, confirmMs: 10_000, ...options };
	}

	get currentStage(): Stage {
		return this.stage;
	}

	start(): void {
		this.stop();
		this.me = {
			userHash: this.o.claim?.userHash ?? this.o.identity.userHash,
			contactPkey: this.o.identity.contactPkey,
			nonce: newNonce(),
		};
		this.peer = null;
		this.T = null;
		this.mySig = null;
		this.conn = null;
		this.myPayload = null;
		this.peerPayload = null;
		this.code = null;
		this.busy = false;
		this.ignoredOwn = false;
		this.timings = {};
		this.started = Date.now();
		this.after(this.o.sessionMs, () => this.finish({ kind: 'expired', reason: `no handshake within ${this.o.sessionMs / 1000} s` }));
		this.log(`session started as ${short(this.me.userHash)}${this.o.claim ? ' (impersonating)' : ''}`);
		this.show({ kind: 'A', ...this.me }, 'A');
	}

	stop(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		this.conn?.close();
		this.stage = 'idle';
	}

	/** A code the camera read. Codes read while the previous one is still being handled are dropped; the camera reads them again. */
	async read(text: string): Promise<void> {
		if (this.stage === 'idle' || this.stage === 'done' || this.busy) return;
		const m = parse(text);
		if (!m) return;
		if (!this.acceptsFrom(m)) return;
		this.busy = true;
		try {
			await this.handle(m);
		} catch (e) {
			this.log(`error handling ${m.kind}: ${(e as Error).message}`);
		} finally {
			this.busy = false;
		}
	}

	private acceptsFrom(m: Message): boolean {
		if (!('userHash' in m)) return true;
		if (m.userHash === this.me.userHash) {
			if (!this.ignoredOwn) this.log('ignored a code with our own identity (a reflection, or a second device of this account)');
			this.ignoredOwn = true;
			return false;
		}
		if (this.peer && (m.userHash !== this.peer.userHash || !same(m.contactPkey, this.peer.contactPkey) || !same(m.nonce, this.peer.nonce))) {
			this.log(`ignored ${m.kind} from another session (${short(m.userHash)})`);
			return false;
		}
		return true;
	}

	private async handle(m: Message): Promise<void> {
		if (m.kind === 'A' && this.stage === 'A') {
			this.bind(m);
			this.mySig = await signOptical(this.T!, this.o.identity.contactSkey);
			this.mark('read A');
			this.show({ kind: 'B', ...this.me, sig: this.mySig }, 'B');
			return;
		}
		if (m.kind === 'B' && (this.stage === 'A' || this.stage === 'B')) {
			if (!this.peer) this.bind(m);
			if (!verifyOptical(m.sig, this.T!, this.peer!.contactPkey)) {
				this.log('B carries a signature that does not verify — staying');
				return;
			}
			this.mark('optically verified');
			this.log(`${short(this.peer!.userHash)} holds the key it showed (optical proof ok)`);
			this.mySig ??= await signOptical(this.T!, this.o.identity.contactSkey);
			this.conn = this.openChannel();
			this.myPayload = await this.conn.payload();
			this.show({ kind: 'C', sig: this.mySig, qwbp: this.myPayload }, 'C');
			return;
		}
		if (m.kind === 'C' && (this.stage === 'B' || this.stage === 'C')) {
			if (!verifyOptical(m.sig, this.T!, this.peer!.contactPkey)) {
				this.log('C carries a signature that does not verify — staying');
				return;
			}
			this.peerPayload = m.qwbp;
			if (this.stage === 'B') {
				this.mark('optically verified');
				this.log(`${short(this.peer!.userHash)} holds the key it showed (optical proof ok)`);
				this.conn = this.openChannel();
				this.myPayload = await this.conn.payload();
				await this.conn.feed(this.peerPayload);
				this.show({ kind: 'D', qwbp: this.myPayload }, 'D');
			} else {
				// Both showed C: both hold both payloads, and QWBP picks the roles.
				this.log('both sides showed C at once — no D needed');
				await this.conn!.feed(this.peerPayload);
			}
			this.payloadsKnown();
			return;
		}
		if (m.kind === 'D' && this.stage === 'C') {
			this.peerPayload = m.qwbp;
			await this.conn!.feed(this.peerPayload);
			this.payloadsKnown();
		}
	}

	private bind(m: { userHash: string; contactPkey: Uint8Array; nonce: Uint8Array }): void {
		this.peer = { userHash: m.userHash, contactPkey: m.contactPkey, nonce: m.nonce };
		this.T = transcript(this.me, this.peer);
		this.log(`bound to ${short(m.userHash)}`);
	}

	private openChannel(): ChannelAdapter {
		const conn = this.o.channel();
		conn.onOpen((link) => this.channelOpen(link));
		return conn;
	}

	private payloadsKnown(): void {
		this.mark('payloads exchanged');
		this.o.onReadingDone?.();
		this.log('both bootstrap payloads known — waiting for the channel');
		this.after(this.o.channelMs, () => {
			if (this.stage === 'done') return;
			this.finish({
				kind: 'verified',
				peerHash: this.peer!.userHash,
				code: null,
				reason: `no channel within ${this.o.channelMs / 1000} s — the phones may not reach each other (same Wi-Fi? try "STUN on")`,
			});
		});
	}

	private channelOpen(link: ChannelLink): void {
		if (this.stage === 'done' || !this.peer || !this.myPayload || !this.peerPayload) return;
		this.mark('channel open');
		const fps = {
			[this.me.userHash]: this.conn!.fingerprintOf(this.myPayload),
			[this.peer.userHash]: this.conn!.fingerprintOf(this.peerPayload),
		};
		const M = pqMessage(this.T!, this.me.userHash, this.peer.userHash, fps);
		this.code = comparisonCode(this.T!, this.me.userHash, this.peer.userHash, fps);
		this.log(`channel open (fingerprints ${bytesToHex(fps[this.me.userHash]).slice(0, 8)}… / ${bytesToHex(fps[this.peer.userHash]).slice(0, 8)}…)`);

		link.onMessage((raw) => {
			if (this.stage === 'done') return;
			const verdict = checkConfirm(raw, this.peer!, M);
			if (verdict.ok) {
				this.log(`confirmed: ${verdict.card.name} — card valid, key certified, post-quantum signature ok`);
				this.finish({ kind: 'confirmed', peerName: verdict.card.name, peerHash: this.peer!.userHash, code: this.code!, card: verdict.card });
			} else {
				this.log(`not confirmed: ${verdict.reason}`);
				this.finish({ kind: 'verified', peerHash: this.peer!.userHash, code: this.code, reason: verdict.reason });
			}
			setTimeout(() => link.close(), 3_000);
		});
		const card = this.o.claim?.card ?? this.o.identity.card;
		link.send(confirmMessage(card, signPq(M, this.o.identity.signSkey)));
		this.after(this.o.confirmMs, () => {
			if (this.stage === 'done') return;
			this.finish({ kind: 'verified', peerHash: this.peer!.userHash, code: this.code, reason: 'the channel opened, but no confirmation came over it' });
		});
	}

	private show(m: Message, stage: Stage): void {
		this.stage = stage;
		this.o.onShow(encode(m), stage);
	}

	private finish(outcome: Outcome): void {
		if (this.stage === 'done') return;
		this.stage = 'done';
		this.mark('done');
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		this.o.onDone(outcome, { ...this.timings });
	}

	private mark(milestone: string): void {
		this.timings[milestone] ??= Date.now() - this.started;
	}

	private after(ms: number, fn: () => void): void {
		this.timers.push(setTimeout(fn, ms));
	}

	private log(line: string): void {
		this.o.onLog(line);
	}
}
