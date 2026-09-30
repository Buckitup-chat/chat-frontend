// Two engines handshaking over a fake network, the camera replaced by each
// reading the other's current code — in either order, at the same moment,
// with no network between them, and with one of them impersonating.
import { describe, it, expect, beforeAll } from 'vitest';
import { HandshakeEngine, type Outcome, type Stage } from '../src/engine';
import { FakeNetwork } from '../src/channel';
import { createIdentity, type Identity } from '../src/identity';

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

const side = (identity: Identity, net: FakeNetwork, extra: Partial<ConstructorParameters<typeof HandshakeEngine>[0]> = {}): Side => {
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
	return s;
};

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Each side reads the other's current code, in the given order, until both are done. */
const run = async (first: Side, second: Side, maxRounds = 20) => {
	for (let i = 0; i < maxRounds && !(first.outcome && second.outcome); i++) {
		await first.engine.read(second.code);
		await second.engine.read(first.code);
		await settle();
	}
	for (let i = 0; i < 150 && !(first.outcome && second.outcome); i++) await settle();
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

	it('with no network between them, end verified in person but not confirmed', async () => {
		const net = new FakeNetwork();
		net.reachable = false;
		const a = side(alice, net);
		const b = side(bob, net);
		await run(a, b);
		expect(a.outcome).toMatchObject({ kind: 'verified', reason: expect.stringMatching(/no channel/) });
		expect(b.outcome).toMatchObject({ kind: 'verified', reason: expect.stringMatching(/no channel/) });
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

	it('a code from another session is ignored once a peer is bound', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net);
		const b = side(bob, net);
		const m = side(mallory, net);
		await a.engine.read(b.code); // a binds to Bob, shows B
		await m.engine.read(a.code); // Mallory reads a's B and shows her C
		await a.engine.read(m.code.replace('PQ2:C', 'PQ2:C')); // C from another transcript: its signature fails
		await a.engine.read(side(mallory, net).code); // A from Mallory: another session
		expect(a.stage).toBe('B');
		expect(a.log.join('\n')).toMatch(/another session|does not verify/);
	});

	it('the session ends when nobody completes it in time', async () => {
		const net = new FakeNetwork();
		const a = side(alice, net, { sessionMs: 200 });
		await new Promise((r) => setTimeout(r, 300));
		expect(a.outcome).toMatchObject({ kind: 'expired' });
	});
});
