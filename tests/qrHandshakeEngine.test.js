// @vitest-environment jsdom
// The PQ2 handshake engine (docs/task-handshake-pq2.md §5, §8): two engines
// driven against each other over a fake network, the camera replaced by each
// reading the other's current code — in either order, at the same moment,
// with no network between them, and with one of them impersonating. Then the
// scanner component with the real QWBP and a stubbed RTCPeerConnection, for
// what reaches WebRTC: the relay or no ICE server at all, and a restarted
// session that the old one cannot touch.
import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { mount, flushPromises } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { HandshakeEngine } from '@/lib/handshake/engine';
import { linkOf } from '@/lib/handshake/qwbpChannel';
import { encode, parse, transcript } from '@/lib/pq/handshake';
import { fromBase64 } from '@/lib/pq/signature';
import { _setRelaySourceForTests } from '@/lib/data/turnCredentials';
import { FakeNetwork, handshakeIdentity, impostorIdentity } from './helpers/fakeHandshakeNetwork';
import { makeTestIdentity, resignedCard } from './helpers/signedFixtures';

// ---------- the scanner component's surroundings (used by the last part) ----------

const scanners = [];
vi.mock('qr-scanner', () => ({
	default: class FakeQrScanner {
		static _disableBarcodeDetector = false;
		constructor(video, onDecode) {
			this.onDecode = onDecode;
			this.decoderAtCreation = !FakeQrScanner._disableBarcodeDetector ? 'BarcodeDetector' : 'qr-scanner';
			this.starts = [];
			this.stops = 0;
			this.nextStart = null;
			scanners.push(this);
		}
		start() {
			const pending = this.nextStart;
			this.nextStart = null;
			this.starts.push(Date.now());
			return pending ?? Promise.resolve();
		}
		stop() { this.stops++; }
		destroy() {}
	},
}));
const drawn = [];
vi.mock('qrcode', () => ({ default: { toCanvas: async (canvas, text) => { drawn.push(text); } } }));

let storeState;
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => storeState }));
const fakeEm = { isAuth: true, currentUserHash: null, signChallenge: async () => new Uint8Array(0) };
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => fakeEm } }));

let alice;
let bob;
let mallory;

beforeAll(() => {
	alice = makeTestIdentity(41, 'Alice');
	bob = makeTestIdentity(42, 'Bob');
	mallory = makeTestIdentity(43, 'Mallory');
});

// ---------- two engines ----------

const sides = [];
afterEach(() => {
	for (const s of sides.splice(0)) s.engine.stop();
	vi.useRealTimers();
});

const side = (identity, net, extra = {}) => {
	const s = { code: '', stage: 'idle', outcome: null, log: [], verified: 0, readingDone: 0 };
	s.engine = new HandshakeEngine({
		identity,
		channel: net.channel,
		// Windows wide enough for real ML-DSA work on a busy machine; the tests about the windows set their own.
		sessionMs: 30_000,
		channelMs: CHANNEL_MS,
		confirmMs: 8_000,
		onShow: (code, stage) => { s.code = code; s.stage = stage; },
		onLog: (line) => s.log.push(line),
		onVerified: () => { s.verified++; },
		onReadingDone: () => { s.readingDone++; },
		onDone: (outcome) => { s.outcome = outcome; s.doneAt = Date.now(); },
		...extra,
	});
	s.engine.start();
	sides.push(s);
	return s;
};

const CHANNEL_MS = 1_500;
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Each side reads the other's current code, in the given order, until `done`. */
const run = async (first, second, done = () => !!(first.outcome && second.outcome)) => {
	for (let i = 0; i < 20 && !done(); i++) {
		await first.engine.read(second.code);
		await second.engine.read(first.code);
		await settle();
	}
	for (let i = 0; i < 600 && !done(); i++) await settle();
};

const delayed = (ms, fn) => async (...args) => { await settle(ms); return fn(...args); };

describe('two phones, face to face', () => {
	it('confirm each other in either order, with each other\'s card and the same six digits', async () => {
		for (const order of ['alice first', 'bob first']) {
			const net = new FakeNetwork();
			const a = side(handshakeIdentity(alice), net);
			const b = side(handshakeIdentity(bob), net);
			if (order === 'alice first') await run(a, b);
			else await run(b, a);
			expect(a.outcome, order).toMatchObject({ kind: 'confirmed', peerHash: bob.userHash, card: { name: 'Bob' } });
			expect(b.outcome, order).toMatchObject({ kind: 'confirmed', peerHash: alice.userHash, card: { name: 'Alice' } });
			expect(a.outcome.peerContactPkey).toEqual(fromBase64(bob.card.contact_pkey));
			expect(a.outcome.sas).toMatch(/^\d{6}$/);
			expect(a.outcome.sas).toBe(b.outcome.sas);
			expect([a.verified, b.verified]).toEqual([1, 1]);
		}
	});

	it('confirm each other when both read at the same moment — both show B, then both show C, and no D is needed', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		const [aA, bA] = [a.code, b.code];
		await Promise.all([a.engine.read(bA), b.engine.read(aA)]);
		expect([a.stage, b.stage]).toEqual(['B', 'B']);
		const [aB, bB] = [a.code, b.code];
		await Promise.all([a.engine.read(bB), b.engine.read(aB)]);
		expect([a.stage, b.stage]).toEqual(['C', 'C']);
		const [aC, bC] = [a.code, b.code];
		await Promise.all([a.engine.read(bC), b.engine.read(aC)]);
		for (let i = 0; i < 600 && !(a.outcome && b.outcome); i++) await settle();
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
		expect(a.outcome.sas).toBe(b.outcome.sas);
		expect(a.log.join('\n')).toMatch(/no D needed/);
	});

	it('confirm each other when the confirmation takes longer than the channel window', async () => {
		const net = new FakeNetwork();
		net.latencyMs = CHANNEL_MS + 500;
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
	});

	it('count a channel that opens late but inside the window, on both sides', async () => {
		const net = new FakeNetwork();
		net.openAfterMs = CHANNEL_MS - 300; // inside the window, which starts when both payloads are known
		net.latencyMs = 600; // the confirmations land after the window would have closed
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
	});

	it('send one confirmation each, though the connection hands over two data channels', async () => {
		const net = new FakeNetwork();
		net.channelsPerOpen = 2;
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
		expect(net.channels.map((c) => c.sent.length)).toEqual([1, 1]);
	});

	it('read a confirmation that arrives before the engine listens on the channel', async () => {
		const net = new FakeNetwork();
		// Alice signs M slowly: Bob's confirmation is on the channel before she listens.
		const a = side(handshakeIdentity(alice, { signPq: delayed(300, async (M) => ml_dsa87.sign(M, alice.signSkey)) }), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed', card: { name: 'Bob' } });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
	});

	it('with no network between them, end verified in person but not confirmed, with no card, the same six digits, and closed connections', async () => {
		const net = new FakeNetwork();
		net.reachable = false;
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'verified', cause: 'no-channel', sas: expect.stringMatching(/^\d{6}$/) });
		expect(b.outcome).toMatchObject({ kind: 'verified', cause: 'no-channel' });
		expect(a.outcome.card).toBeUndefined();
		expect(a.outcome.sas).toBe(b.outcome.sas);
		expect(net.channels.map((c) => c.closed)).toEqual([true, true]);
	});

	it('a phone with no network interface at all ends verified in person at once, not at a timeout', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net, { channel: () => net.channel({ address: false }) });
		const b = side(handshakeIdentity(bob), net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await b.engine.read(a.code); // b verifies, shows C
		const readAt = Date.now();
		await a.engine.read(b.code); // a verifies C, needs its own payload for D
		expect(a.outcome).toMatchObject({ kind: 'verified', cause: 'no-address', sas: null, reason: 'no address' });
		expect(a.log.join('\n')).toMatch(/no network address/);
		expect(a.doneAt - readAt).toBeLessThan(100);
		expect(net.channels[0].closed).toBe(true);
	});

	it('an account whose card was never published sends a refusal: the peer names that cause, and the account still confirms the peer', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice, { signedCard: async () => null }), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(b.outcome).toMatchObject({ kind: 'verified', cause: 'peer-unable', reason: expect.stringMatching(/no card/) });
		expect(a.outcome).toMatchObject({ kind: 'confirmed', card: { name: 'Bob' } });
	});

	it('a confirmation that cannot be signed is named as such, here and on the peer — not as a missing channel', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice, { signPq: async () => { throw new Error('vault locked'); } }), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect(b.outcome).toMatchObject({ kind: 'verified', cause: 'peer-unable', reason: expect.stringMatching(/no signature/) });
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });

		const net2 = new FakeNetwork();
		net2.reachable = false;
		const c = side(handshakeIdentity(alice, { signPq: async () => { throw new Error('vault locked'); } }), net2);
		const d = side(handshakeIdentity(bob), net2);
		await run(c, d);
		expect(c.outcome).toMatchObject({ kind: 'verified', cause: 'no-signature' });
		expect(d.outcome).toMatchObject({ kind: 'verified', cause: 'no-channel' });
	});

	it('a deleted account is never confirmed, and the cause says so', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob, { signedCard: async () => resignedCard(bob, { deleted_flag: true }) }), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'verified', cause: 'deleted' });
	});

	it('an optical signature that fails once is signed again on the next read, and the session goes on', async () => {
		const net = new FakeNetwork();
		let failures = 1;
		const real = handshakeIdentity(alice).signOptical;
		const a = side(handshakeIdentity(alice, { signOptical: async (T) => { if (failures-- > 0) throw new Error('busy'); return real(T); } }), net);
		const b = side(handshakeIdentity(bob), net);
		await a.engine.read(b.code);
		expect(a.stage).toBe('A');
		await a.engine.read(b.code);
		expect(a.stage).toBe('B');
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
	});

	it('an optical signature that keeps failing ends the session with its own cause', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice, { signOptical: async () => { throw new Error('no key'); } }), net);
		const b = side(handshakeIdentity(bob), net);
		for (let i = 0; i < 3; i++) await a.engine.read(b.code);
		expect(a.outcome).toEqual({ kind: 'failed', cause: 'no-signature' });
		expect(net.channels[0].closed).toBe(true);
	});

	it('stop reading once both payloads are known', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await run(a, b);
		expect([a.readingDone, b.readingDone]).toEqual([1, 1]);
	});
});

describe('what is refused', () => {
	it('a phone showing someone else\'s identity with its own key is never confirmed', async () => {
		const net = new FakeNetwork();
		const honest = side(handshakeIdentity(bob), net);
		const impostor = side(impostorIdentity(mallory, alice), net);
		await run(honest, impostor);
		expect(honest.outcome).toMatchObject({
			kind: 'verified', cause: 'refused', peerHash: alice.userHash,
			reason: 'the card does not certify the contact key the codes showed',
		});
	});

	it('a confirmation with a foreign card leaves the phone not confirmed', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob, { signedCard: async () => mallory.card }), net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'verified', cause: 'refused', reason: expect.stringMatching(/another identity/) });
	});

	it('its own code is ignored', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		await a.engine.read(a.code);
		expect(a.stage).toBe('A');
		expect(a.log.join('\n')).toMatch(/own identity/);
	});

	it('a B whose signature does not verify binds nothing: the phone still completes with its real counterpart', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		// Mallory's B, signed for another session of Bob's: a stale or stray code.
		const m = side(handshakeIdentity(mallory), net);
		await m.engine.read(side(handshakeIdentity(bob), net).code);
		await a.engine.read(m.code);
		expect(a.stage).toBe('A');
		expect(a.log.join('\n')).toMatch(/B carries a signature that does not verify/);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed', card: { name: 'Bob' } });
	});

	it('a recorded B replayed to a new session is ignored: the nonce differs', async () => {
		const net = new FakeNetwork();
		const a1 = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await b.engine.read(a1.code); // Bob shows a B for Alice's first session
		const recorded = b.code;
		a1.engine.stop();
		const a2 = side(handshakeIdentity(alice), net);
		await a2.engine.read(recorded);
		expect(a2.stage).toBe('A');
		expect(a2.log.join('\n')).toMatch(/does not verify/);
	});

	it('a C signed by the right key over another session is refused, and the real C taken', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await b.engine.read(a.code); // b verifies, shows C
		expect(b.stage).toBe('C');
		const real = parse(b.code);
		const other = transcript(
			{ userHash: alice.userHash, contactPkey: fromBase64(alice.card.contact_pkey), nonce: new Uint8Array(16).fill(7) },
			{ userHash: bob.userHash, contactPkey: fromBase64(bob.card.contact_pkey), nonce: new Uint8Array(16).fill(8) },
		);
		const sig = await handshakeIdentity(bob).signOptical(other);
		await a.engine.read(encode({ kind: 'C', sig, qwbp: real.qwbp }));
		expect(a.stage).toBe('B');
		expect(a.log.join('\n')).toMatch(/C carries a signature that does not verify/);
		await a.engine.read(b.code);
		expect(a.stage).toBe('D');
	});

	it('a D from another session is ignored, and the real D taken', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await b.engine.read(a.code); // b verifies, shows C
		await a.engine.read(b.code); // a verifies, shows D
		expect(a.stage).toBe('D');
		const real = parse(a.code);
		// A neighbouring pair's D: its own payload, under its own session.
		const neighbour = net.channel();
		await b.engine.read(encode({ kind: 'D', tag: new Uint8Array(6).fill(1), qwbp: await neighbour.payload() }));
		expect(b.log.join('\n')).toMatch(/ignored a D from another session/);
		await b.engine.read(a.code);
		await run(a, b);
		expect(a.outcome?.kind).toBe('confirmed');
		expect(b.outcome?.kind).toBe('confirmed');
	});

	it('once bound, codes from another session are ignored', async () => {
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net);
		const b = side(handshakeIdentity(bob), net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await a.engine.read(side(handshakeIdentity(mallory), net).code);
		await a.engine.read(side(handshakeIdentity(bob), net).code); // Bob again, another nonce
		expect(a.stage).toBe('B');
		expect(a.log.filter((l) => /ignored A from another session/.test(l))).toHaveLength(2);
	});
});

describe('the end of a session', () => {
	it('comes 90 s after the start when nobody completes it, and nothing is read after it', async () => {
		vi.useFakeTimers();
		const net = new FakeNetwork();
		const a = side(handshakeIdentity(alice), net, { sessionMs: undefined });
		const b = side(handshakeIdentity(bob), net, { sessionMs: undefined });
		await vi.advanceTimersByTimeAsync(89_900);
		expect(a.outcome).toBeNull();
		await vi.advanceTimersByTimeAsync(200);
		expect(a.outcome).toMatchObject({ kind: 'expired' });
		expect(net.channels[0].closed).toBe(true);
		await a.engine.read(b.code);
		expect(a.stage).toBe('A'); // nothing more shown
		expect(a.engine.currentStage).toBe('done');
	});

	it('is final: work under way when it is stopped shows, logs and reports nothing', async () => {
		const net = new FakeNetwork();
		let release;
		const slowSign = (T) => new Promise((resolve) => { release = () => resolve(handshakeIdentity(alice).signOptical(T)); });
		const a = side(handshakeIdentity(alice, { signOptical: slowSign }), net);
		const b = side(handshakeIdentity(bob), net);
		const reading = a.engine.read(b.code); // signs, then would show B
		await settle();
		a.engine.stop();
		const logged = a.log.length;
		release();
		await reading;
		await settle();
		expect(a.stage).toBe('A');
		expect(a.log).toHaveLength(logged);
		expect(a.outcome).toBeNull();
		expect(net.channels[0].closed).toBe(true);
	});
});

describe('the data channel link', () => {
	it('keeps a message that arrives before anyone listens, and hands it over in order', () => {
		const channel = { onmessage: null, send: () => {} };
		const link = linkOf(channel);
		channel.onmessage({ data: 'first' });
		channel.onmessage({ data: 'second' });
		const got = [];
		link.onMessage((text) => got.push(text));
		channel.onmessage({ data: 'third' });
		expect(got).toEqual(['first', 'second', 'third']);
	});
});

// ---------- the scanner component, the real QWBP, a stubbed RTCPeerConnection ----------

/** Every RTCPeerConnection made, with the configuration it was made with. */
const peerConnections = [];
const hex32 = (n) => Array.from({ length: 32 }, (_, i) => ((n + i) & 0xff).toString(16).padStart(2, '0')).join(':');
let certificates = 0;

class StubPeerConnection {
	static async generateCertificate() { return { id: ++certificates }; }
	constructor(configuration) {
		this.configuration = configuration;
		this.createdAt = Date.now();
		this.localDescription = null;
		this.iceGatheringState = 'new';
		this.closed = false;
		this.fingerprint = hex32(peerConnections.length * 7 + 1);
		peerConnections.push(this);
	}
	createDataChannel(label) { return { label, close() {} }; }
	async createOffer() {
		return { type: 'offer', sdp: `v=0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${this.fingerprint}\r\n` };
	}
	async setLocalDescription(description) {
		this.localDescription = description;
		// Gathering: one host address, then the end of candidates.
		setTimeout(() => {
			if (this.closed) return;
			this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host' } });
			this.iceGatheringState = 'complete';
			this.onicecandidate?.({ candidate: null });
		}, 5);
	}
	async setRemoteDescription() {}
	async addIceCandidate() {}
	async createAnswer() { return { type: 'answer', sdp: '' }; }
	close() { this.closed = true; }
}

const iceUrls = (pc) => (pc.configuration.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

describe('the scanner: what reaches WebRTC', () => {
	let QRScannerEngine;
	let fetches;

	beforeAll(async () => {
		QRScannerEngine = (await import('@/components/engines/QRScannerEngine.vue')).default;
	});

	beforeEach(() => {
		peerConnections.length = 0;
		scanners.length = 0;
		drawn.length = 0;
		vi.stubGlobal('RTCPeerConnection', StubPeerConnection);
		vi.stubGlobal('RTCIceCandidate', class { constructor(init) { Object.assign(this, init); } });
		fetches = [];
		storeState = {
			currentUserHash: alice.userHash,
			currentUser: { contact_pkey: alice.card.contact_pkey },
			allNetworkUsers: [],
			signContactChallenge: async (T) => {
				const sig = await handshakeIdentity(alice).signOptical(T);
				return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
			},
			signHandshakePQ: async (M) => ml_dsa87.sign(M, alice.signSkey),
			signedOwnCard: async () => alice.card,
		};
		fakeEm.currentUserHash = alice.userHash;
		fakeEm.signChallenge = async (bytes) => ml_dsa87.sign(bytes, alice.signSkey);
		_setRelaySourceForTests(null); // the real endpoint client
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		_setRelaySourceForTests(null);
	});

	/** The backend: a challenge, and turn_credentials answering `turn`. */
	const backend = (turn) => vi.stubGlobal('fetch', async (url, init = {}) => {
		fetches.push({ url: String(url), init });
		if (String(url).endsWith('/challenge')) {
			return new Response(JSON.stringify({ challenge_id: 'c1', challenge: 'a challenge: not base64 at all ✓', expires_in: 60 }), { status: 200 });
		}
		if (String(url).endsWith('/turn_credentials')) return turn(init);
		return new Response('{}', { status: 404 });
	});

	const mountScanner = async () => {
		const wrapper = mount(QRScannerEngine, { attachTo: document.body });
		await flushPromises();
		return wrapper;
	};

	const startAndWaitForConnection = async (wrapper, timeout = 3_000) => {
		await wrapper.vm.toggleScanner();
		await vi.waitFor(() => expect(peerConnections).toHaveLength(1), { timeout });
		return peerConnections[0];
	};

	it('decodes with qr-scanner\'s own decoder, not BarcodeDetector', async () => {
		const wrapper = await mountScanner();
		expect(scanners[0].decoderAtCreation).toBe('qr-scanner');
		// The switch is global: it is put back, so another scanner (device link) keeps the browser's decoder.
		const QrScanner = (await import('qr-scanner')).default;
		expect(QrScanner._disableBarcodeDetector).toBe(false);
		wrapper.unmount();
	});

	it('shows A at once and starts the session with no ICE server when the credentials request fails', async () => {
		backend(async () => { throw new TypeError('Failed to fetch'); });
		const wrapper = await mountScanner();
		const pc = await startAndWaitForConnection(wrapper);
		expect(drawn[0]).toMatch(/^PQ2:A:/);
		expect(pc.configuration.iceServers).toEqual([]);
		wrapper.unmount();
	});

	it('starts the session with no ICE server on 503 turn_unavailable', async () => {
		backend(async () => new Response(JSON.stringify({ error: 'turn_unavailable' }), { status: 503 }));
		const wrapper = await mountScanner();
		const pc = await startAndWaitForConnection(wrapper);
		expect(pc.configuration.iceServers).toEqual([]);
		expect(fetches.map((f) => f.url)).toEqual(['/api/challenge', '/api/turn_credentials']);
		wrapper.unmount();
	});

	it('waits at most 1 s for an answer that does not come, then starts with no ICE server', async () => {
		backend(() => new Promise(() => {}));
		const wrapper = await mountScanner();
		const started = Date.now();
		const pc = await startAndWaitForConnection(wrapper);
		expect(drawn[0]).toMatch(/^PQ2:A:/);
		expect(pc.createdAt - started).toBeGreaterThanOrEqual(950);
		expect(pc.createdAt - started).toBeLessThan(1_800);
		expect(pc.configuration.iceServers).toEqual([]);
		wrapper.unmount();
	});

	it('gives the connection our relay as its only ICE server, proved over the challenge\'s UTF-8 bytes', async () => {
		const uris = ['turn:relay.test:3478?transport=udp', 'turn:relay.test:3478?transport=tcp'];
		backend(async () => new Response(JSON.stringify({ username: '1791200000:6f1c', credential: 'c3VwZXI=', ttl: 600, uris }), { status: 200 }));
		const wrapper = await mountScanner();
		const pc = await startAndWaitForConnection(wrapper);
		expect(pc.configuration.iceServers).toEqual([{ urls: uris, username: '1791200000:6f1c', credential: 'c3VwZXI=' }]);
		const body = JSON.parse(fetches.find((f) => f.url.endsWith('/turn_credentials')).init.body);
		expect(body).toMatchObject({ user_hash: alice.userHash, challenge_id: 'c1' });
		expect(body.signature).not.toMatch(/=/);
		const sig = fromBase64(body.signature);
		expect(ml_dsa87.verify(sig, new TextEncoder().encode('a challenge: not base64 at all ✓'), fromBase64(alice.card.sign_pkey))).toBe(true);
		wrapper.unmount();
	});

	it('never names a third party\'s STUN server, and keeps QWBP\'s connection longer than any session', async () => {
		backend(async () => new Response('{}', { status: 404 }));
		const wrapper = await mountScanner();
		const pc = await startAndWaitForConnection(wrapper);
		expect(iceUrls(pc).filter((u) => /stun:|google/i.test(u))).toEqual([]);
		const { QWBP_TIMEOUT_MS } = await import('@/lib/handshake/qwbpChannel');
		expect(QWBP_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
		wrapper.unmount();
	});

	it('a session restarted while the old one waits for the camera is not stopped by it', async () => {
		backend(async () => new Response('{}', { status: 404 }));
		const wrapper = await mountScanner();
		const scanner = scanners[0];
		let cameraFails;
		scanner.nextStart = new Promise((_, reject) => { cameraFails = reject; });
		const first = wrapper.vm.toggleScanner();
		await flushPromises();
		wrapper.vm.stopScan();
		await wrapper.vm.toggleScanner(); // the second session's camera starts at once
		const stopsBefore = scanner.stops;
		cameraFails(new Error('NotReadableError'));
		await first;
		await flushPromises();
		expect(scanner.stops).toBe(stopsBefore);
		expect(wrapper.emitted('scanning').at(-1)).toEqual([true]);
		expect(wrapper.text()).not.toMatch(/camera did not start/i);
		wrapper.unmount();
	});

	it('a session restarted while the old one waits for its signature is never drawn over by it', async () => {
		backend(async () => new Response('{}', { status: 404 }));
		let release;
		storeState.signContactChallenge = (T) => new Promise((resolve) => {
			release = async () => resolve(Array.from(await handshakeIdentity(alice).signOptical(T), (b) => b.toString(16).padStart(2, '0')).join(''));
		});
		const wrapper = await mountScanner();
		await wrapper.vm.toggleScanner();
		const peer = side(handshakeIdentity(bob), new FakeNetwork());
		scanners[0].onDecode({ data: peer.code }); // Bob's A: the old session signs, then would show B
		await flushPromises();
		wrapper.vm.stopScan();
		await wrapper.vm.toggleScanner();
		const drawnBefore = drawn.length;
		await release();
		await flushPromises();
		await settle(50);
		expect(drawn.slice(drawnBefore).filter((c) => c.startsWith('PQ2:B:'))).toEqual([]);
		expect(drawn.at(-1)).toMatch(/^PQ2:A:/);
		expect(wrapper.find('[data-stage]').attributes('data-stage')).toBe('A');
		expect(wrapper.emitted('completed')).toBeUndefined();
		wrapper.unmount();
	});
});
