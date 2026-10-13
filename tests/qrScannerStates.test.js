// @vitest-environment jsdom
// The scanner component's states, two of them face to face: each mounted
// component is a phone, its camera reads whatever the other one drew last,
// and the channel between them is the fake network. What the person sees —
// the code, the step, the result and the six digits — and what the modal
// gets from `completed`.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { FakeNetwork, handshakeIdentity } from './helpers/fakeHandshakeNetwork';
import { makeTestIdentity } from './helpers/signedFixtures';

const scanners = [];
vi.mock('qr-scanner', () => ({
	default: class FakeQrScanner {
		constructor(video, onDecode) {
			this.onDecode = onDecode;
			this.running = false;
			scanners.push(this);
		}
		async start() { this.running = true; }
		stop() { this.running = false; }
		destroy() {}
	},
}));
/** The last code drawn on each canvas. */
const codes = new Map();
vi.mock('qrcode', () => ({ default: { toCanvas: async (canvas, text) => { codes.set(canvas, text); } } }));

let net;
vi.mock('@/lib/handshake/qwbpChannel', () => ({ QwbpChannel: class { constructor() { return net.channel(); } } }));
vi.mock('@/lib/data/turnCredentials', () => ({ relayIceServers: async () => [] }));

let nextStore;
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => nextStore }));

const { default: QRScannerEngine } = await import('@/components/engines/QRScannerEngine.vue');

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const storeOf = (id, extra = {}) => ({
	currentUserHash: id.userHash,
	currentUser: { contact_pkey: id.card.contact_pkey },
	allNetworkUsers: [],
	signContactChallenge: async (T) => toHex(await handshakeIdentity(id).signOptical(T)),
	signHandshakePQ: async (M) => ml_dsa87.sign(M, id.signSkey),
	signedOwnCard: async () => id.card,
	...extra,
});

let alice;
let bob;
beforeAll(() => {
	alice = makeTestIdentity(51, 'Alice');
	bob = makeTestIdentity(52, 'Bob');
});

const phones = [];
const phone = async (id, extra) => {
	nextStore = storeOf(id, extra);
	const wrapper = mount(QRScannerEngine, { attachTo: document.body });
	await flushPromises();
	const p = {
		wrapper,
		scanner: scanners.at(-1),
		code: () => codes.get(wrapper.find('canvas').element),
		stage: () => wrapper.find('[data-stage]').attributes('data-stage'),
		outcome: () => wrapper.find('[data-stage]').attributes('data-outcome'),
		/** The camera reads a code; the engine signs with real crypto, which takes a few turns. */
		read: async (text) => {
			if (p.scanner.running && text) p.scanner.onDecode({ data: text });
			await flushPromises();
			await new Promise((r) => setTimeout(r, 30));
			await flushPromises();
		},
	};
	phones.push(p);
	return p;
};

/** Each camera reads the other's screen until both are done. */
const faceToFace = async (a, b, done = () => !!(a.wrapper.emitted('completed') && b.wrapper.emitted('completed'))) => {
	for (let i = 0; i < 40 && !done(); i++) {
		await a.read(b.code());
		await b.read(a.code());
		await new Promise((r) => setTimeout(r, 25));
	}
};

beforeEach(() => {
	net = new FakeNetwork();
	scanners.length = 0;
	codes.clear();
});

afterEach(() => {
	for (const p of phones.splice(0)) p.wrapper.unmount();
	vi.useRealTimers();
});

describe('the scanner, two phones face to face', () => {
	it('shows nothing until started, then its identity code, the step and the 25–40 cm hint', async () => {
		const a = await phone(alice);
		expect(a.wrapper.find('[data-stage]').isVisible()).toBe(false);
		await a.wrapper.vm.toggleScanner();
		await flushPromises();
		expect(a.wrapper.emitted('scanning')).toEqual([[true]]);
		expect(a.code()).toMatch(/^PQ2:A:u_/);
		expect(a.stage()).toBe('A');
		expect(a.wrapper.text()).toMatch(/25–40 cm/);
		expect(a.wrapper.text()).toMatch(/Showing my identity/);
	});

	it('walks A → B → C → D, ends confirmed on both, keeps the last code on screen and shows the same six digits', async () => {
		const a = await phone(alice);
		const b = await phone(bob);
		await a.wrapper.vm.toggleScanner();
		await b.wrapper.vm.toggleScanner();
		await flushPromises();

		await a.read(b.code());
		expect(a.stage()).toBe('B');
		expect(a.code()).toMatch(/^PQ2:B:/);
		await b.read(a.code());
		expect(b.stage()).toBe('C');
		expect(b.code()).toMatch(/^PQ2:C:/);
		await a.read(b.code());
		expect(a.stage()).toBe('D');
		expect(a.code()).toMatch(/^PQ2:D:/);
		await b.read(a.code());
		await vi.waitFor(() => expect(a.wrapper.emitted('completed') && b.wrapper.emitted('completed')).toBeTruthy());

		const [ra] = a.wrapper.emitted('completed')[0];
		const [rb] = b.wrapper.emitted('completed')[0];
		expect(ra).toMatchObject({ user_hash: bob.userHash, contact_pkey: bob.card.contact_pkey, confirmed: true, name: 'Bob', cause: null });
		expect(ra.card).toEqual(bob.card);
		expect(rb).toMatchObject({ user_hash: alice.userHash, confirmed: true, name: 'Alice' });
		expect(ra.sas).toMatch(/^\d{6}$/);
		expect(ra.sas).toBe(rb.sas);
		for (const p of [a, b]) {
			await flushPromises();
			expect(p.outcome()).toBe('confirmed');
			// The result and the six digits are the modal's to show, once.
			expect(p.wrapper.text()).not.toMatch(/Contact confirmed|\d{3} ?\d{3}/);
			expect(p.scanner.running).toBe(false);
			expect(p.wrapper.emitted('scanning').at(-1)).toEqual([false]);
		}
		expect(a.code()).toMatch(/^PQ2:D:/); // still there for the other camera
	});

	it('ends verified in person, not confirmed, when the channel does not open in 15 s — with the six digits and the cause', async () => {
		net.reachable = false;
		// The engine's timers are fake from the start, so 15 s can pass at once; the crypto runs as it does.
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
		const a = await phone(alice);
		const b = await phone(bob);
		await a.wrapper.vm.toggleScanner();
		await b.wrapper.vm.toggleScanner();
		await faceToFace(a, b, () => !!(a.scanner.running === false && b.scanner.running === false));
		await vi.advanceTimersByTimeAsync(15_100);
		await flushPromises();
		await flushPromises();
		const [ra] = a.wrapper.emitted('completed')[0];
		expect(ra).toMatchObject({ confirmed: false, card: null, cause: 'no-channel', name: 'Unknown user', sas: expect.stringMatching(/^\d{6}$/) });
		expect(ra.reason).toBeUndefined();
		expect(a.outcome()).toBe('verified');
	});

	it('names the peer from a known card when the handshake did not confirm it', async () => {
		net.reachable = false;
		// The engine's timers are fake from the start, so 15 s can pass at once; the crypto runs as it does.
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
		const a = await phone(alice, { allNetworkUsers: [{ user_hash: bob.userHash, name: 'Bob (known)' }] });
		const b = await phone(bob);
		await a.wrapper.vm.toggleScanner();
		await b.wrapper.vm.toggleScanner();
		await faceToFace(a, b, () => a.scanner.running === false);
		await vi.advanceTimersByTimeAsync(15_100);
		await flushPromises();
		expect(a.wrapper.emitted('completed')[0][0].name).toBe('Bob (known)');
	});

	it('expires after 90 s: the code goes, the session is over, and a new start makes a new code', async () => {
		vi.useFakeTimers();
		const a = await phone(alice);
		await a.wrapper.vm.toggleScanner();
		await flushPromises();
		const first = a.code();
		await vi.advanceTimersByTimeAsync(90_100);
		expect(a.wrapper.emitted('completed')).toBeUndefined();
		expect(a.wrapper.text()).toMatch(/Session expired/);
		expect(a.scanner.running).toBe(false);
		await a.wrapper.vm.toggleScanner();
		await flushPromises();
		expect(a.code()).toMatch(/^PQ2:A:/);
		expect(a.code()).not.toBe(first); // a new nonce
	});

	it('stops when asked: the camera stops, the code is cleared and nothing the old session read counts', async () => {
		const a = await phone(alice);
		const b = await phone(bob);
		await a.wrapper.vm.toggleScanner();
		await b.wrapper.vm.toggleScanner();
		await flushPromises();
		const oldA = a.code();
		await a.wrapper.vm.toggleScanner(); // stop
		expect(a.scanner.running).toBe(false);
		expect(a.wrapper.emitted('scanning').at(-1)).toEqual([false]);
		await b.read(oldA); // Bob still reads Alice's old A and shows B for it
		await a.wrapper.vm.toggleScanner(); // a new session
		await flushPromises();
		await a.read(b.code()); // Bob's B names Alice's old nonce
		expect(a.stage()).toBe('A');
	});

	it('says so when the camera does not start', async () => {
		const a = await phone(alice);
		a.scanner.start = async () => { throw new Error('NotAllowedError'); };
		await a.wrapper.vm.toggleScanner();
		await flushPromises();
		expect(a.wrapper.text()).toMatch(/camera did not start/i);
		expect(a.wrapper.emitted('scanning').at(-1)).toEqual([false]);
	});
});
