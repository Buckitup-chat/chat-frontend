// The PQ2 state machine (docs/task-handshake-pq2.md §5), without DOM or
// camera. The scanner component feeds it the codes the camera reads and shows
// the codes it asks to show; the channel is an adapter — QWBP over WebRTC in
// the browser (qwbpChannel.ts), a fake network in the tests.
//
// One engine runs one session. Once it has finished or been stopped it shows,
// sends, logs and reports nothing more: every await is followed by a check of
// `ended`, so work a stopped session still had under way cannot draw over,
// stop the camera of, or complete the session that replaced it.
import { bytesToHex } from '@noble/hashes/utils';
import { equalBytes } from '@noble/post-quantum/utils.js';
import {
	checkConfirm, confirmMessage, encode, fingerprintOf, newNonce, parse, pqMessage, sasOf, sessionTag, transcript,
	verifyOptical, type Fingerprints, type Message, type Party,
} from '@/lib/pq/handshake';
import type { UserCardRow } from '@/lib/data/types';

export interface ChannelLink {
	send(text: string): void;
	onMessage(handler: (text: string) => void): void;
}

export interface ChannelAdapter {
	/** This side's bootstrap payload; the first call sets the connection up. Rejects when nothing could reach this side. */
	payload(): Promise<Uint8Array>;
	/** The peer's payload, as read from its code. */
	feed(peerPayload: Uint8Array): Promise<void>;
	/** Called with each data channel that opens; the engine takes the first. */
	onOpen(handler: (link: ChannelLink) => void): void;
	close(): void;
}

/** What the engine needs of the account: its handshake key and the two signatures (EncryptionManagerPQ). */
export interface HandshakeIdentity {
	userHash: string;
	/** Compressed secp256k1, 33 bytes: the card's contact_pkey. */
	contactPkey: Uint8Array;
	/** ECDSA secp256k1 over SHA-256(T), compact r‖s. */
	signOptical(T: Uint8Array): Promise<Uint8Array>;
	/** ML-DSA-87 over M under the identity key. */
	signPq(M: Uint8Array): Promise<Uint8Array>;
	/** The account's freshest self-signed card, or null when none was published. */
	signedCard(): Promise<UserCardRow | null>;
}

export type Stage = 'idle' | 'A' | 'B' | 'C' | 'D' | 'done';

export type Outcome =
	/** The peer's card certifies the key proved in person, and its identity signed this session and channel. */
	| { kind: 'confirmed'; peerHash: string; peerContactPkey: Uint8Array; sas: string; card: UserCardRow }
	/** The key was proved in person; the post-quantum step did not complete. No SAS without a channel's fingerprints. */
	| { kind: 'verified'; peerHash: string; peerContactPkey: Uint8Array; sas: string | null; reason: string; cause: VerifiedCause }
	| { kind: 'expired'; reason: string };

/** Why a session ended verified only: what the person can do about it differs. */
export type VerifiedCause = 'no-address' | 'no-channel' | 'no-card' | 'no-confirmation' | 'refused';

export interface EngineOptions {
	identity: HandshakeIdentity;
	/** The session's connection, created at start (§5a step 1). */
	channel: () => ChannelAdapter;
	/** For reading the codes, up to both payloads known. */
	sessionMs?: number;
	/** From both payloads known to the channel being open. */
	channelMs?: number;
	/** From the channel opening to the peer's confirmation. */
	confirmMs?: number;
	onShow(code: string, stage: Stage): void;
	onLog?(line: string): void;
	/** The peer's key is proved in person. */
	onVerified?(): void;
	/** Both payloads are known: nothing is left to read. */
	onReadingDone?(): void;
	onDone(outcome: Outcome): void;
}

export const SESSION_MS = 90_000;
export const CHANNEL_MS = 15_000;
export const CONFIRM_MS = 10_000;
/** Our confirmation may still be on its way when the peer's arrives: the connection closes this much later. */
const CLOSE_AFTER_CHANNEL_MS = 3_000;

export const NO_CHANNEL_REASON =
	'Key verified in person; not yet confirmed — check that both phones are online, or scan again on a shared Wi-Fi.';

const short = (hash: string) => `${hash.slice(0, 10)}…`;
const partyOf = (m: Party): Party => ({ userHash: m.userHash, contactPkey: m.contactPkey, nonce: m.nonce });

export class HandshakeEngine {
	private readonly o: EngineOptions & Required<Pick<EngineOptions, 'sessionMs' | 'channelMs' | 'confirmMs'>>;
	private stage: Stage = 'idle';
	private ended = false;
	private me!: Party;
	private peer: Party | null = null;
	private T: Uint8Array | null = null;
	private mySig: Promise<Uint8Array> | null = null;
	private ownCard: Promise<UserCardRow | null> | null = null;
	private conn: ChannelAdapter | null = null;
	private myPayload: Uint8Array | null = null;
	private peerPayload: Uint8Array | null = null;
	/** Once both payloads are known: the fingerprints and the six digits. */
	private bound: { fps: Fingerprints; sas: string } | null = null;
	/** Our confirmation message, once signed. */
	private message: string | null = null;
	private link: ChannelLink | null = null;
	private listening = false;
	private busy = false;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private readonly noted = new Set<string>();

	constructor(options: EngineOptions) {
		this.o = {
			...options,
			sessionMs: options.sessionMs ?? SESSION_MS,
			channelMs: options.channelMs ?? CHANNEL_MS,
			confirmMs: options.confirmMs ?? CONFIRM_MS,
		};
	}

	get currentStage(): Stage {
		return this.stage;
	}

	get isEnded(): boolean {
		return this.ended;
	}

	start(): void {
		if (this.stage !== 'idle' || this.ended) throw new Error('An engine runs one session');
		this.me = { userHash: this.o.identity.userHash, contactPkey: this.o.identity.contactPkey, nonce: newNonce() };
		// The connection gathers its addresses — a relay allocation takes up to a
		// second or two — while the codes are read, so C shows as soon as the
		// peer is verified. Its payload is shown first in C or D, never before.
		this.conn = this.o.channel();
		this.conn.onOpen((link) => this.channelOpen(link));
		this.conn.payload().catch(() => {}); // reported when C or D needs it
		this.ownCard = this.o.identity.signedCard().catch((e: unknown) => {
			this.log(`own card: ${(e as Error)?.message ?? e}`);
			return null;
		});
		this.setDeadline(this.o.sessionMs, () => ({ kind: 'expired', reason: `no handshake within ${this.o.sessionMs / 1000} s` }));
		this.log(`session started as ${short(this.me.userHash)}`);
		this.show({ kind: 'A', ...this.me }, 'A');
	}

	/** Ends the session with no outcome. */
	stop(): void {
		this.ended = true;
		clearTimeout(this.deadline);
		this.conn?.close();
	}

	/** A code the camera read. Codes read while the previous one is still being handled are dropped; the camera reads them again. */
	async read(text: string): Promise<void> {
		if (this.stage === 'idle' || this.ended || this.busy) return;
		const m = parse(text);
		if (!m || !this.acceptsFrom(m)) return;
		this.busy = true;
		try {
			await this.handle(m);
		} catch (e) {
			this.log(`error handling ${m.kind}: ${(e as Error)?.message ?? e}`);
		} finally {
			this.busy = false;
		}
	}

	private acceptsFrom(m: Message): boolean {
		if (!('userHash' in m)) return true;
		if (m.userHash === this.me.userHash) {
			this.noteOnce('ignored a code with our own identity (a reflection, or a second device of this account)');
			return false;
		}
		if (this.peer && (m.userHash !== this.peer.userHash || !equalBytes(m.contactPkey, this.peer.contactPkey) || !equalBytes(m.nonce, this.peer.nonce))) {
			this.noteOnce(`ignored ${m.kind} from another session (${short(m.userHash)})`);
			return false;
		}
		return true;
	}

	private async handle(m: Message): Promise<void> {
		if (m.kind === 'A' && this.stage === 'A') {
			this.bind(m);
			const sig = await this.signature();
			if (this.ended) return;
			this.show({ kind: 'B', ...this.me, sig }, 'B');
		} else if (m.kind === 'B' && (this.stage === 'A' || this.stage === 'B')) {
			// Bound only once its signature verifies: a stale B, or one meant for
			// another phone, must not take the session.
			const peer = this.peer ?? partyOf(m);
			if (!verifyOptical(m.sig, this.T ?? transcript(this.me, peer), peer.contactPkey)) {
				this.noteOnce('B carries a signature that does not verify — staying');
				return;
			}
			if (!this.peer) this.bind(peer);
			this.opticallyVerified();
			const [sig, payload] = await Promise.all([this.signature(), this.payload()]);
			if (this.ended || !payload) return;
			this.show({ kind: 'C', sig, qwbp: payload }, 'C');
		} else if (m.kind === 'C' && (this.stage === 'B' || this.stage === 'C') && !this.peerPayload) {
			if (!verifyOptical(m.sig, this.T!, this.peer!.contactPkey)) {
				this.noteOnce('C carries a signature that does not verify — staying');
				return;
			}
			if (this.stage === 'B') {
				this.opticallyVerified();
				const payload = await this.payload();
				if (!payload || !(await this.feed(m.qwbp))) return;
				this.show({ kind: 'D', tag: sessionTag(this.T!), qwbp: payload }, 'D');
			} else {
				// Both showed C: both hold both payloads, and QWBP picks the roles.
				if (!(await this.feed(m.qwbp))) return;
				this.log('both sides showed C at once — no D needed');
			}
			await this.payloadsKnown();
		} else if (m.kind === 'D' && this.stage === 'C' && !this.peerPayload) {
			if (!equalBytes(m.tag, sessionTag(this.T!))) this.noteOnce('ignored a D from another session');
			else if (await this.feed(m.qwbp)) await this.payloadsKnown();
		} else {
			// The camera keeps reading a code after its step is done; said once.
			this.noteOnce(`${m.kind} read at stage ${this.stage}: nothing to do`);
		}
	}

	private bind(peer: Party): void {
		this.peer = partyOf(peer);
		this.T = transcript(this.me, this.peer);
		this.log(`bound to ${short(peer.userHash)}`);
	}

	/** Our optical signature over T, signed once. */
	private signature(): Promise<Uint8Array> {
		this.mySig ??= this.o.identity.signOptical(this.T!);
		return this.mySig;
	}

	private opticallyVerified(): void {
		this.log(`${short(this.peer!.userHash)} holds the key it showed (optical proof ok)`);
		this.o.onVerified?.();
	}

	/** Own payload, or null when the session is over — it ends here when the connection could not be set up. */
	private async payload(): Promise<Uint8Array | null> {
		try {
			this.myPayload = await this.conn!.payload();
		} catch (e) {
			const reason = `no channel: ${(e as Error)?.message ?? e}`;
			this.log(reason);
			this.finishVerified(reason, 'no-address');
		}
		return this.ended ? null : this.myPayload;
	}

	/** Hands the peer's payload to the connection; false when the session ended meanwhile. */
	private async feed(peerPayload: Uint8Array): Promise<boolean> {
		try {
			await this.conn!.feed(peerPayload);
		} catch (e) {
			if (!this.ended) this.log(`the peer's payload was not taken: ${(e as Error)?.message ?? e}`);
			return false;
		}
		if (this.ended) return false;
		this.peerPayload = peerPayload;
		return true;
	}

	/** Both payloads fix M and the six digits: M is signed now, while the channel opens. */
	private async payloadsKnown(): Promise<void> {
		this.o.onReadingDone?.();
		const peer = this.peer!;
		const fps: Fingerprints = {
			[this.me.userHash]: fingerprintOf(this.myPayload!),
			[peer.userHash]: fingerprintOf(this.peerPayload!),
		};
		const sas = sasOf(this.T!, fps);
		this.bound = { fps, sas };
		const fp = (hash: string) => `${bytesToHex(fps[hash]).slice(0, 8)}…`;
		this.log(`both bootstrap payloads known (fingerprints ${fp(this.me.userHash)} / ${fp(peer.userHash)}) — waiting for the channel`);
		// The channel window starts now, unless the channel is already open.
		if (!this.link) this.setDeadline(this.o.channelMs, () => this.verified(NO_CHANNEL_REASON, 'no-channel'));
		const [card, sigPq] = await Promise.all([this.ownCard!, this.o.identity.signPq(pqMessage(this.T!, fps))]);
		if (this.ended) return;
		if (!card) {
			this.finishVerified('this account\'s card is not published yet, so the other phone cannot confirm it', 'no-card');
			return;
		}
		this.message = confirmMessage(card, sigPq);
		if (this.link) this.exchange();
	}

	private channelOpen(link: ChannelLink): void {
		// QWBP can hand over two data channels: the first one counts.
		if (this.ended || this.link) return;
		this.link = link;
		this.log('channel open');
		if (this.message) this.exchange();
		else if (this.bound) this.setDeadline(this.o.confirmMs, () => this.verified('the channel opened, but no confirmation came over it', 'no-confirmation'));
	}

	/** The channel is open and M is signed: send ours — once — and wait for theirs. */
	private exchange(): void {
		if (this.listening) return;
		this.listening = true;
		const { fps, sas } = this.bound!;
		const peer = this.peer!;
		const T = this.T!;
		this.setDeadline(this.o.confirmMs, () => this.verified('the channel opened, but no confirmation came over it', 'no-confirmation'));
		this.link!.onMessage((raw) => {
			if (this.ended) return;
			const verdict = checkConfirm(raw, peer, T, fps);
			if (verdict.ok) {
				this.log(`confirmed: ${verdict.card.name} — card valid, key certified, post-quantum signature ok`);
				this.finish({ kind: 'confirmed', peerHash: peer.userHash, peerContactPkey: peer.contactPkey, sas, card: verdict.card });
			} else {
				this.log(`not confirmed: ${verdict.reason}`);
				this.finishVerified(verdict.reason, 'refused');
			}
		});
		this.link!.send(this.message!);
	}

	private verified(reason: string, cause: VerifiedCause): Outcome {
		return { kind: 'verified', peerHash: this.peer!.userHash, peerContactPkey: this.peer!.contactPkey, sas: this.bound?.sas ?? null, reason, cause };
	}

	private finishVerified(reason: string, cause: VerifiedCause): void {
		this.finish(this.verified(reason, cause));
	}

	private show(m: Message, stage: Stage): void {
		this.stage = stage;
		this.o.onShow(encode(m), stage);
	}

	private finish(outcome: Outcome): void {
		if (this.ended) return;
		this.stage = 'done';
		this.ended = true;
		clearTimeout(this.deadline);
		const conn = this.conn;
		if (conn && this.link) setTimeout(() => conn.close(), CLOSE_AFTER_CHANNEL_MS);
		else conn?.close();
		this.o.onDone(outcome);
	}

	private noteOnce(line: string): void {
		if (this.noted.has(line)) return;
		this.noted.add(line);
		this.log(line);
	}

	/** One deadline at a time: reading the codes, then the channel opening, then the confirmation. */
	private setDeadline(ms: number, outcome: () => Outcome): void {
		clearTimeout(this.deadline);
		this.deadline = setTimeout(() => this.finish(outcome()), ms);
	}

	private log(line: string): void {
		if (!this.ended) this.o.onLog?.(line);
	}
}
