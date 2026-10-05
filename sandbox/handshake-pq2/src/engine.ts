// The PQ2 state machine (docs/task-handshake-pq2.md §5), without DOM or
// camera. The page feeds it the codes the camera reads and shows the codes it
// asks to show; the channel is an adapter — QWBP over WebRTC in the browser,
// a fake network in the tests — or, in the animated-QR mode (frames.ts), the
// cameras themselves. One engine runs one session: once it has finished or
// been stopped, it shows, sends, logs and reports nothing more.
import { bytesToHex } from '@noble/hashes/utils';
import { equalBytes } from '@noble/post-quantum/utils.js';
import { toBytes } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';
import type { Identity } from './identity';
import {
	checkProof, decodeProof, encodeFrame, encodeProof, fromBase45, nameBytesOf, parseFrame, proofMessage, senderTag,
	sessionCode, split, toBase45, type Frame,
} from './frames';
import {
	checkConfirm, comparisonCode, confirmMessage, encode, newNonce, parse, pqMessage, sessionTag, signOptical, signPq,
	transcript, verifyOptical, type Message, type Party,
} from './protocol';

export interface ChannelLink {
	send(text: string): void;
	onMessage(handler: (text: string) => void): void;
}

export interface ChannelAdapter {
	/** This side's bootstrap payload; the first call sets the connection up. Rejects when nothing could reach this side. */
	payload(): Promise<Uint8Array>;
	/** The peer's payload, as read from its code. */
	feed(peerPayload: Uint8Array): Promise<void>;
	onOpen(handler: (link: ChannelLink) => void): void;
	fingerprintOf(payload: Uint8Array): Uint8Array;
	close(): void;
}

export type Stage = 'idle' | 'A' | 'B' | 'C' | 'D' | 'F' | 'done';

export type Outcome =
	| { kind: 'confirmed'; peerName: string; peerHash: string; code: string; card?: UserCardRow }
	| { kind: 'verified'; peerHash: string; code: string | null; reason: string }
	| { kind: 'expired'; reason: string };

export interface Timings {
	[milestone: string]: number;
}

/** Animated-QR progress: frames of ours the peer reports holding, and frames of the peer's we hold. */
export interface FramesProgress {
	sent: number;
	peerHas: number;
	received: number;
	/** The peer's frame count. */
	total: number;
}

export interface EngineOptions {
	identity: Identity;
	/** The network channel; not used in the animated-QR mode. */
	channel?: () => ChannelAdapter;
	/** Animated-QR mode: the proof goes through the cameras as a loop of frames, and no network is used. */
	frames?: { dataChars: number; fps: number };
	/** Animated-QR mode: from the first frame shown to both sides holding everything. */
	framesMs?: number;
	onProgress?(progress: FramesProgress): void;
	/** Impersonation test: show this user_hash with our own contact key, and send this card. */
	claim?: { userHash: string; card: UserCardRow };
	/** For reading the codes, up to both payloads known. */
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

/** Our confirmation may still be on its way when the peer's arrives: the connection closes this much later. */
const CLOSE_AFTER_CHANNEL_MS = 3_000;
/**
 * Animated-QR mode: how long a device that holds the peer's whole proof keeps
 * showing its own frames for a peer that has not yet reported holding them.
 */
const LINGER_MS = 20_000;

const short = (hash: string) => `${hash.slice(0, 10)}…`;
const partyOf = (m: Party): Party => ({ userHash: m.userHash, contactPkey: m.contactPkey, nonce: m.nonce });

export class HandshakeEngine {
	private readonly o: EngineOptions & Required<Pick<EngineOptions, 'sessionMs' | 'channelMs' | 'confirmMs' | 'framesMs'>>;
	private stage: Stage = 'idle';
	private ended = false;
	private me!: Party;
	private peer: Party | null = null;
	private T: Uint8Array | null = null;
	private mySig: Uint8Array | null = null;
	private conn: ChannelAdapter | null = null;
	private myPayload: Uint8Array | null = null;
	private peerPayload: Uint8Array | null = null;
	/** Once both payloads are known: what the channel must carry, and the six digits. */
	private confirmation: { M: Uint8Array; message: string; code: string } | null = null;
	private link: ChannelLink | null = null;
	private busy = false;
	private started = 0;
	private timings: Timings = {};
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private readonly idle = new Set<string>();
	// Animated-QR mode.
	private ownFrames: string[] | null = null;
	private frameAt = 0;
	private frameTimer: ReturnType<typeof setInterval> | undefined;
	private peerFrames: Array<string | null> | null = null;
	private received = 0;
	private peerHas = 0;
	private framesResult: Outcome | null = null;

	constructor(options: EngineOptions) {
		this.o = { sessionMs: 90_000, channelMs: 15_000, confirmMs: 10_000, framesMs: 120_000, ...options };
	}

	get currentStage(): Stage {
		return this.stage;
	}

	start(): void {
		if (this.stage !== 'idle' || this.ended) throw new Error('An engine runs one session');
		this.started = Date.now();
		this.me = {
			userHash: this.o.claim?.userHash ?? this.o.identity.userHash,
			contactPkey: this.o.identity.contactPkey,
			nonce: newNonce(),
		};
		if (!this.o.frames) {
			// The connection gathers its addresses while the codes are read, so C
			// shows as soon as the peer is verified; gathering can take seconds.
			this.conn = this.o.channel!();
			this.conn.onOpen((link) => this.channelOpen(link));
			this.conn.payload().catch(() => {}); // starts gathering; reported when C or D needs it
		}
		this.setDeadline(this.o.sessionMs, () => ({ kind: 'expired', reason: `no handshake within ${this.o.sessionMs / 1000} s` }));
		this.log(`session started as ${short(this.me.userHash)}${this.o.claim ? ' (impersonating)' : ''}`);
		this.show({ kind: 'A', ...this.me }, 'A');
	}

	/** Ends the session with no outcome. */
	stop(): void {
		this.ended = true;
		clearTimeout(this.deadline);
		clearInterval(this.frameTimer);
		this.conn?.close();
	}

	/** A code the camera read. Codes read while the previous one is still being handled are dropped; the camera reads them again. */
	async read(text: string): Promise<void> {
		if (this.stage === 'idle' || this.ended || this.busy) return;
		const frame = this.o.frames ? parseFrame(text) : null;
		const m = frame ? null : parse(text);
		if (!frame && (!m || !this.acceptsFrom(m))) return;
		this.busy = true;
		try {
			if (frame) await this.onFrame(frame);
			else await this.handle(m!);
		} catch (e) {
			this.log(`error handling ${frame ? 'a frame' : m!.kind}: ${(e as Error).message}`);
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
			this.log(`ignored ${m.kind} from another session (${short(m.userHash)})`);
			return false;
		}
		return true;
	}

	// Every await is followed by a check of `ended`: the session may have
	// finished or been stopped meanwhile.
	private async handle(m: Message): Promise<void> {
		if (m.kind === 'A' && this.stage === 'A') {
			this.bind(m);
			const sig = await this.signature();
			if (this.ended) return;
			this.mark('read A');
			this.show({ kind: 'B', ...this.me, sig }, 'B');
		} else if (m.kind === 'B' && (this.stage === 'A' || this.stage === 'B')) {
			// Bound only once its signature verifies: a stale B, or one meant for
			// another phone, must not take the session.
			const peer = this.peer ?? partyOf(m);
			if (!verifyOptical(m.sig, this.T ?? transcript(this.me, peer), peer.contactPkey)) {
				this.log('B carries a signature that does not verify — staying');
				return;
			}
			if (!this.peer) this.bind(peer);
			this.opticallyVerified();
			if (this.o.frames) {
				await this.startFrames();
				return;
			}
			const [sig, payload] = await Promise.all([this.signature(), this.payload()]);
			if (this.ended || !payload) return;
			this.show({ kind: 'C', sig, qwbp: payload }, 'C');
		} else if (m.kind === 'C' && (this.stage === 'B' || this.stage === 'C') && !this.peerPayload) {
			if (!verifyOptical(m.sig, this.T!, this.peer!.contactPkey)) {
				this.log('C carries a signature that does not verify — staying');
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
			this.payloadsKnown();
		} else if (m.kind === 'D' && this.stage === 'C' && !this.peerPayload) {
			if (!equalBytes(m.tag, sessionTag(this.T!))) this.noteOnce('ignored a D from another session');
			else if (await this.feed(m.qwbp)) this.payloadsKnown();
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

	private async signature(): Promise<Uint8Array> {
		this.mySig ??= await signOptical(this.T!, this.o.identity.contactSkey);
		return this.mySig;
	}

	private opticallyVerified(): void {
		this.mark('optically verified');
		this.log(`${short(this.peer!.userHash)} holds the key it showed (optical proof ok)`);
	}

	/** Own payload, or null when the session is over — it ends here when the connection could not be set up. */
	private async payload(): Promise<Uint8Array | null> {
		try {
			this.myPayload = await this.conn!.payload();
		} catch (e) {
			const reason = `no channel: ${(e as Error).message}`;
			this.log(reason);
			this.finish({ kind: 'verified', peerHash: this.peer!.userHash, code: null, reason });
		}
		return this.ended ? null : this.myPayload;
	}

	/** Hands the peer's payload to the connection; false when the session ended meanwhile. */
	private async feed(peerPayload: Uint8Array): Promise<boolean> {
		await this.conn!.feed(peerPayload);
		if (this.ended) return false;
		this.peerPayload = peerPayload;
		return true;
	}

	/** Both payloads fix M and the six digits: M is signed now, while the channel opens. */
	private payloadsKnown(): void {
		this.mark('payloads exchanged');
		this.o.onReadingDone?.();
		const peer = this.peer!;
		const fps = {
			[this.me.userHash]: this.conn!.fingerprintOf(this.myPayload!),
			[peer.userHash]: this.conn!.fingerprintOf(this.peerPayload!),
		};
		const M = pqMessage(this.T!, this.me.userHash, peer.userHash, fps);
		const card = this.o.claim?.card ?? this.o.identity.card;
		this.confirmation = {
			M,
			message: confirmMessage(card, signPq(M, this.o.identity.signSkey)),
			code: comparisonCode(this.T!, this.me.userHash, peer.userHash, fps),
		};
		const fp = (hash: string) => `${bytesToHex(fps[hash]).slice(0, 8)}…`;
		this.log(`both bootstrap payloads known (fingerprints ${fp(this.me.userHash)} / ${fp(peer.userHash)}) — waiting for the channel`);
		if (this.link) {
			this.sendConfirmation();
			return;
		}
		const { code } = this.confirmation;
		this.setDeadline(this.o.channelMs, () => ({
			kind: 'verified',
			peerHash: peer.userHash,
			code,
			reason: `no channel within ${this.o.channelMs / 1000} s — the phones may not reach each other (same Wi-Fi? try "STUN on")`,
		}));
	}

	private channelOpen(link: ChannelLink): void {
		if (this.ended || this.link) return;
		this.link = link;
		this.mark('channel open');
		this.log('channel open');
		if (this.confirmation) this.sendConfirmation();
	}

	/** The channel is open and M is signed: send ours, and wait for theirs. */
	private sendConfirmation(): void {
		const { M, message, code } = this.confirmation!;
		const peer = this.peer!;
		this.link!.onMessage((raw) => {
			if (this.ended) return;
			const verdict = checkConfirm(raw, peer, M);
			if (verdict.ok) {
				this.log(`confirmed: ${verdict.card.name} — card valid, key certified, post-quantum signature ok`);
				this.finish({ kind: 'confirmed', peerName: verdict.card.name, peerHash: peer.userHash, code, card: verdict.card });
			} else {
				this.log(`not confirmed: ${verdict.reason}`);
				this.finish({ kind: 'verified', peerHash: peer.userHash, code, reason: verdict.reason });
			}
		});
		this.setDeadline(this.o.confirmMs, () => ({
			kind: 'verified',
			peerHash: peer.userHash,
			code,
			reason: 'the channel opened, but no confirmation came over it',
		}));
		this.link!.send(message);
	}

	private show(m: Message, stage: Stage): void {
		this.stage = stage;
		this.o.onShow(encode(m), stage);
	}

	private finish(outcome: Outcome): void {
		if (this.ended) return;
		this.stage = 'done';
		this.mark('done');
		this.ended = true;
		clearTimeout(this.deadline);
		clearInterval(this.frameTimer);
		const conn = this.conn;
		if (conn && this.link) setTimeout(() => conn.close(), CLOSE_AFTER_CHANNEL_MS);
		else conn?.close();
		this.o.onDone(outcome, { ...this.timings });
	}

	// ---------- animated-QR mode ----------

	/** Sign the proof and loop it as frames; from here the camera reads the peer's frames. */
	private async startFrames(): Promise<void> {
		if (this.ownFrames) return;
		const card = this.o.claim?.card ?? this.o.identity.card;
		const nameBytes = nameBytesOf(card.name);
		const T = this.T!;
		const bytes = encodeProof({
			opticalSig: await this.signature(),
			signPkey: toBytes(card.sign_pkey!),
			pqSig: signPq(proofMessage(T, nameBytes), this.o.identity.signSkey),
			nameBytes,
		});
		if (this.ended) return;
		this.ownFrames = split(toBase45(bytes), this.o.frames!.dataChars);
		this.stage = 'F';
		this.mark('frames started');
		this.log(`sending the proof (${bytes.length} bytes) as ${this.ownFrames.length} frames`);
		const peerHash = this.peer!.userHash;
		this.setDeadline(this.o.framesMs, () => ({
			kind: 'verified',
			peerHash,
			code: sessionCode(T),
			reason: `the frames did not get across within ${this.o.framesMs / 1000} s`,
		}));
		this.frameTimer = setInterval(() => this.showFrame(), 1000 / this.o.frames!.fps);
		this.showFrame();
	}

	private showFrame(): void {
		const frames = this.ownFrames!;
		const index = this.frameAt++ % frames.length;
		this.o.onShow(
			encodeFrame({ sender: senderTag(this.me.nonce), index, total: frames.length, received: this.received, data: frames[index] }),
			'F',
		);
	}

	private async onFrame(f: Frame): Promise<void> {
		if (f.sender === senderTag(this.me.nonce)) return; // our own, in a reflection
		if (!this.peer || f.sender !== senderTag(this.peer.nonce)) {
			this.noteOnce(`ignored frames of another session (${f.sender})`);
			return;
		}
		// The peer sends frames once it verified our B: ours go out too. Its own
		// optical signature comes inside its proof.
		if (this.stage === 'B') await this.startFrames();
		if (this.ended || this.stage !== 'F') return;
		this.peerHas = Math.max(this.peerHas, Math.min(f.received, this.ownFrames!.length));
		this.peerFrames ??= new Array(f.total).fill(null);
		if (f.total !== this.peerFrames.length) {
			this.noteOnce('frames disagree on their count');
			return;
		}
		if (this.peerFrames[f.index] === null) {
			this.peerFrames[f.index] = f.data;
			this.received++;
			if (this.received === f.total) {
				this.assemble();
				// Our frames carry the full count from now on, starting with the one
				// on screen, which stays there when the session ends: the peer
				// finishes on reading it.
				this.showFrame();
			}
		}
		this.o.onProgress?.({ sent: this.ownFrames!.length, peerHas: this.peerHas, received: this.received, total: f.total });
		if (this.framesResult && this.peerHas === this.ownFrames!.length) {
			this.mark('peer holds every frame');
			this.finish(this.framesResult);
		}
	}

	/** The peer's whole proof is in: check it, and keep our frames up until the peer has all of them too. */
	private assemble(): void {
		this.mark('frames received');
		const peer = this.peer!;
		const code = sessionCode(this.T!);
		const bytes = fromBase45(this.peerFrames!.join(''));
		const proof = bytes && decodeProof(bytes);
		const verdict = proof ? checkProof(proof, peer, this.T!) : { ok: false as const, reason: 'the frames do not make a proof' };
		if (verdict.ok) {
			this.log(`confirmed: ${verdict.name} — identity key matches, optical and post-quantum signatures ok`);
			this.framesResult = { kind: 'confirmed', peerName: verdict.name, peerHash: peer.userHash, code };
		} else {
			this.log(`not confirmed: ${verdict.reason}`);
			this.framesResult = { kind: 'verified', peerHash: peer.userHash, code, reason: verdict.reason };
		}
		const result = this.framesResult;
		this.setDeadline(LINGER_MS, () => result);
	}

	private noteOnce(line: string): void {
		if (this.idle.has(line)) return;
		this.idle.add(line);
		this.log(line);
	}

	private mark(milestone: string): void {
		this.timings[milestone] ??= Date.now() - this.started;
	}

	/** One deadline at a time: reading the codes, then the channel opening, then the confirmation. */
	private setDeadline(ms: number, outcome: () => Outcome): void {
		clearTimeout(this.deadline);
		this.deadline = setTimeout(() => this.finish(outcome()), ms);
	}

	private log(line: string): void {
		if (!this.ended) this.o.onLog(line);
	}
}
