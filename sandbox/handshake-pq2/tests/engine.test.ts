// Two engines handshaking over a fake network, the camera replaced by each
// reading the other's current code — in either order, at the same moment,
// with no network between them, and with one of them impersonating.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { HandshakeEngine, type EngineOptions, type Outcome, type Stage } from '../src/engine';
import { FakeNetwork } from '../src/channel';
import { createIdentity, type Identity } from '../src/identity';
import { encode, parse, signOptical, transcript } from '../src/protocol';

interface Side {
	engine: HandshakeEngine;
	code: string;
	stage: Stage;
	outcome: Outcome | null;
	log: string[];
}

let alice: Identity;
let bob: Identity;
let mallory: Identity;

beforeAll(() => {
	alice = createIdentity('Alice');
	bob = createIdentity('Bob');
	mallory = createIdentity('Mallory');
});

const sides: Side[] = [];
afterEach(() => {
	for (const s of sides.splice(0)) s.engine.stop();
});

const side = (identity: Identity, net: FakeNetwork, extra: Partial<EngineOptions> = {}): Side => {
	const s = { code: '', stage: 'idle', outcome: null, log: [] } as unknown as Side;
	s.engine = new HandshakeEngine({
		identity,
		channel: net.channel,
		sessionMs: 5_000,
		channelMs: 400,
		confirmMs: 2_000,
		onShow: (code, stage) => { s.code = code; s.stage = stage; },
		onLog: (line) => s.log.push(line),
		onDone: (outcome) => { s.outcome = outcome; },
		...extra,
	});
	s.engine.start();
	sides.push(s);
	return s;
};

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Each side reads the other's current code, in the given order, until `done`. */
const run = async (first: Side, second: Side, done = () => !!(first.outcome && second.outcome)) => {
	for (let i = 0; i < 20 && !done(); i++) {
		await first.engine.read(second.code);
		await second.engine.read(first.code);
		await settle();
	}
	for (let i = 0; i < 150 && !done(); i++) await settle();
};

describe('two phones, face to face', () => {
	it('confirm each other in either order, and show the same six digits', async () => {
		for (const order of ['alice first', 'bob first']) {
			const net = new FakeNetwork();
			const a = side(alice, net);
			const b = side(bob, net);
			if (order === 'alice first') await run(a, b);
			else await run(b, a);
			expect(a.outcome, order).toMatchObject({ kind: 'confirmed', peerName: 'Bob' });
			expect(b.outcome, order).toMatchObject({ kind: 'confirmed', peerName: 'Alice' });
			expect((a.outcome as { code: string }).code).toBe((b.outcome as { code: string }).code);
		}
	});

	it('confirm each other when both read at the same moment — both show B, then both show C, and no D is needed', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		const [aA, bA] = [a.code, b.code];
		await Promise.all([a.engine.read(bA), b.engine.read(aA)]);
		expect([a.stage, b.stage]).toEqual(['B', 'B']);
		const [aB, bB] = [a.code, b.code];
		await Promise.all([a.engine.read(bB), b.engine.read(aB)]);
		expect([a.stage, b.stage]).toEqual(['C', 'C']);
		const [aC, bC] = [a.code, b.code];
		await Promise.all([a.engine.read(bC), b.engine.read(aC)]);
		for (let i = 0; i < 150 && !(a.outcome && b.outcome); i++) await settle();
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
		expect(a.log.join('\n')).toMatch(/no D needed/);
	});

	it('confirm each other when the confirmation takes longer than the channel took to open', async () => {
		const net = new FakeNetwork();
		net.latencyMs = 600; // channelMs is 400
		const a = side(alice, net);
		const b = side(bob, net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed' });
		expect(b.outcome).toMatchObject({ kind: 'confirmed' });
	});

	it('with no network between them, end verified in person but not confirmed, with the same six digits, and close their connections', async () => {
		const net = new FakeNetwork();
		net.reachable = false;
		const a = side(alice, net);
		const b = side(bob, net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'verified', reason: expect.stringMatching(/no channel/), code: expect.stringMatching(/^\d{6}$/) });
		expect(b.outcome).toMatchObject({ kind: 'verified', reason: expect.stringMatching(/no channel/) });
		expect((a.outcome as { code: string }).code).toBe((b.outcome as { code: string }).code);
		expect(net.channels.map((c) => c.closed)).toEqual([true, true]);
	});

	it('a phone with no network address ends verified in person with no channel, and closes its connection', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net, { channel: () => net.channel({ address: false }) });
		const b = side(bob, net);
		await run(a, b, () => !!a.outcome);
		expect(a.outcome).toMatchObject({ kind: 'verified', code: null, reason: expect.stringMatching(/no network address/) });
		expect(net.channels[0].closed).toBe(true);
	});
});

describe('what is refused', () => {
	it('a phone showing someone else\'s identity with its own key is not confirmed', async () => {
		const net = new FakeNetwork();
		const honest = side(bob, net);
		const impostor = side(mallory, net, { claim: { userHash: alice.userHash, card: alice.card } });
		await run(honest, impostor);
		expect(honest.outcome).toMatchObject({ kind: 'verified', reason: 'card does not certify the contact key the codes showed' });
	});

	it('its own code is ignored', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		await a.engine.read(a.code);
		expect(a.stage).toBe('A');
		expect(a.log.join('\n')).toMatch(/own identity/);
	});

	it('a B whose signature does not verify binds nothing: the phone still completes with its real counterpart', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		// Mallory's B, signed for another session of Bob's: a stale or stray code.
		const m = side(mallory, net);
		await m.engine.read(side(bob, net).code);
		await a.engine.read(m.code);
		expect(a.stage).toBe('A');
		expect(a.log.join('\n')).toMatch(/B carries a signature that does not verify/);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'confirmed', peerName: 'Bob' });
	});

	it('a C signed by the right key over another session is refused, and the real C taken', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await b.engine.read(a.code); // b verifies, shows C
		expect(b.stage).toBe('C');
		const real = parse(b.code);
		if (real?.kind !== 'C') throw new Error('expected C');
		const other = transcript({ userHash: alice.userHash, contactPkey: alice.contactPkey, nonce: new Uint8Array(16).fill(7) }, { userHash: bob.userHash, contactPkey: bob.contactPkey, nonce: new Uint8Array(16).fill(8) });
		await a.engine.read(encode({ kind: 'C', sig: await signOptical(other, bob.contactSkey), qwbp: real.qwbp }));
		expect(a.stage).toBe('B');
		expect(a.log.join('\n')).toMatch(/C carries a signature that does not verify/);
		await a.engine.read(b.code);
		expect(a.stage).toBe('D');
	});

	it('once bound, codes from another session are ignored', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		await a.engine.read(b.code); // a binds Bob, shows B
		await a.engine.read(side(mallory, net).code);
		await a.engine.read(side(bob, net).code); // Bob again, another nonce
		expect(a.stage).toBe('B');
		expect(a.log.filter((l) => /ignored A from another session/.test(l))).toHaveLength(2);
	});
});

describe('the end of a session', () => {
	it('comes when nobody completes it in time', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net, { sessionMs: 200 });
		await new Promise((r) => setTimeout(r, 300));
		expect(a.outcome).toMatchObject({ kind: 'expired' });
	});

	it('is final: work still under way when it is stopped shows, logs and reports nothing', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		const reading = a.engine.read(b.code); // signs, then would show B
		a.engine.stop();
		const logged = a.log.length;
		await reading;
		await settle();
		expect(a.stage).toBe('A');
		expect(a.log).toHaveLength(logged);
		expect(a.outcome).toBeNull();
		expect(net.channels[0].closed).toBe(true);
	});
});
