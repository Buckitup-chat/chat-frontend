// The room client against a fake socket that honours the channel's contract:
// a join is answered with phx_reply carrying the join's ref, a "signal" push
// is rebroadcast to every *other* member with the sender's id, and
// "user_joined" goes to everyone including the joiner. That is exactly what
// the staging channel was observed to do; a fake that answered differently
// would make every assertion here a test of the fake.
import { describe, it, expect, vi } from 'vitest';
import { joinRoom, roomSocketUrl } from '@/lib/deviceLink/room';

type Frame = [string | null, string | null, string, string, Record<string, unknown>];

class FakeChannel {
	members = new Map<string, FakeSocket>();
	private n = 0;
	connect(socket: FakeSocket) {
		this.n += 1;
		const id = `user_${this.n}`;
		this.members.set(id, socket);
		return id;
	}
	handle(from: string, frame: Frame) {
		const [joinRef, ref, topic, event, payload] = frame;
		const sender = this.members.get(from)!;
		if (event === 'phx_join') {
			sender.deliver([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]);
			for (const [, s] of this.members) s.deliver([null, null, topic, 'user_joined', { user_id: from }]);
		} else if (event === 'signal') {
			for (const [id, s] of this.members) {
				if (id !== from) s.deliver([null, null, topic, 'signal', { from, ...payload }]);
			}
		} else if (event === 'heartbeat') {
			sender.deliver([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]);
		}
	}
	/** A member's socket going away: the channel tells the others. */
	leave(who: string) {
		this.members.delete(who);
		for (const [, s] of this.members) s.deliver([null, null, 'room:r1', 'user_left', { user_id: who }]);
	}
	/** The channel process dying under a member. */
	crash(who: string) {
		this.members.get(who)!.deliver(['1', null, 'room:r1', 'phx_error', {}]);
	}
}

class FakeSocket {
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	id: string;
	closed = false;
	constructor(private channel: FakeChannel, private behaviour: 'ok' | 'refuse' | 'hang' | 'deaf' = 'ok') {
		this.id = channel.connect(this);
		queueMicrotask(() => {
			if (behaviour === 'refuse') { this.onclose?.(); return; }
			this.onopen?.();
		});
	}
	send(text: string) {
		if (this.behaviour === 'hang') return;
		// 'deaf': the join is answered, then the stream goes dead - frames are
		// swallowed, nothing comes back, and no close ever arrives.
		if (this.behaviour === 'deaf' && JSON.parse(text)[3] !== 'phx_join') return;
		queueMicrotask(() => this.channel.handle(this.id, JSON.parse(text)));
	}
	deliver(frame: Frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	/** The server side going away, as a real socket reports it. */
	drop() {
		this.closed = true;
		this.onclose?.();
	}
	close() { this.closed = true; }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const socketsOf = (channel: FakeChannel) => [...channel.members.values()];

describe('joinRoom', () => {
	it('derives the socket URL from the API base', () => {
		expect(roomSocketUrl('https://buckitup.xyz')).toBe('wss://buckitup.xyz/webrtc-socket/websocket?vsn=2.0.0');
		expect(roomSocketUrl('http://localhost:4000/')).toBe('ws://localhost:4000/webrtc-socket/websocket?vsn=2.0.0');
	});

	it('delivers a broadcast to the other device', async () => {
		const channel = new FakeChannel();
		const makeSocket = () => new FakeSocket(channel) as unknown as WebSocket;
		const a = await joinRoom('ws://x', 'r1', { makeSocket });
		const b = await joinRoom('ws://x', 'r1', { makeSocket });
		const seen: unknown[] = [];
		b.onMessage((data, from) => seen.push([data, from]));
		a.send({ kind: 'offer', kemPublicKey: 'pk' });
		await tick();
		// The sender's channel id rides along: it is what a screen pins its peer by.
		expect(seen).toEqual([[{ kind: 'offer', kemPublicKey: 'pk' }, 'user_1']]);
	});

	it('tells a member who left, and reports the channel dying as a close', async () => {
		const channel = new FakeChannel();
		const makeSocket = () => new FakeSocket(channel) as unknown as WebSocket;
		const a = await joinRoom('ws://x', 'r1', { makeSocket });
		await joinRoom('ws://x', 'r1', { makeSocket });
		const left: string[] = [];
		let closed = 0;
		a.onLeave((who) => left.push(who));
		a.onClose(() => (closed += 1));
		channel.leave('user_2');
		expect(left).toEqual(['user_2']);
		channel.crash('user_1');
		expect(closed).toBe(1);
	});

	it('tells a member when another one joins, which is the cue to resend the offer', async () => {
		const channel = new FakeChannel();
		const makeSocket = () => new FakeSocket(channel) as unknown as WebSocket;
		const a = await joinRoom('ws://x', 'r1', { makeSocket });
		let joins = 0;
		a.onJoin(() => (joins += 1));
		await joinRoom('ws://x', 'r1', { makeSocket });
		await tick();
		expect(joins).toBe(1);
	});

	it('does not leak one room into another', async () => {
		const channel = new FakeChannel();
		const makeSocket = () => new FakeSocket(channel) as unknown as WebSocket;
		const a = await joinRoom('ws://x', 'r1', { makeSocket });
		const other = await joinRoom('ws://x', 'r2', { makeSocket });
		const seen: unknown[] = [];
		other.onMessage((data) => seen.push(data));
		a.send({ kind: 'offer' });
		await tick();
		// The fake channel is topic-agnostic, so this is the client filtering
		// frames by its own topic — the property a real channel also relies on.
		expect(seen).toEqual([]);
	});

	it('rejects when the socket closes before the join is answered', async () => {
		const channel = new FakeChannel();
		await expect(joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel, 'refuse') as unknown as WebSocket }))
			.rejects.toThrow(/closed/);
	});

	it('rejects and closes the socket when aborted while the join hangs', async () => {
		// A modal closed on a slow network used to leave this socket open, with
		// its heartbeat, for the rest of the tab's life.
		const channel = new FakeChannel();
		const controller = new AbortController();
		const pending = joinRoom('ws://x', 'r1', {
			signal: controller.signal,
			makeSocket: () => new FakeSocket(channel, 'hang') as unknown as WebSocket,
		});
		await tick();
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		expect(socketsOf(channel)[0].closed).toBe(true);
	});

	it('gives up on a join the server never answers', async () => {
		vi.useFakeTimers();
		try {
			const channel = new FakeChannel();
			const pending = joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel, 'hang') as unknown as WebSocket });
			// Expectation first, clock second: the rejection fires inside the
			// advance, and a promise nobody is listening to yet is reported as
			// an unhandled error even when the test then goes on to pass.
			const outcome = expect(pending).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(16_000);
			await outcome;
			expect(socketsOf(channel)[0].closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a heartbeat that gets no reply as the socket having died', async () => {
		// A phone that changed networks mid-link never sends a FIN: the socket
		// stays "open" while nothing crosses it. The missed reply is the signal.
		vi.useFakeTimers();
		try {
			const channel = new FakeChannel();
			const room = await joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel, 'deaf') as unknown as WebSocket });
			let closed = 0;
			room.onClose(() => (closed += 1));
			await vi.advanceTimersByTimeAsync(30_000);
			expect(closed).toBe(0);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(closed).toBe(1);
			expect(socketsOf(channel)[0].closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a socket whose heartbeats are answered', async () => {
		vi.useFakeTimers();
		try {
			const channel = new FakeChannel();
			const room = await joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel) as unknown as WebSocket });
			let closed = 0;
			room.onClose(() => (closed += 1));
			await vi.advanceTimersByTimeAsync(95_000);
			expect(closed).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a socket that drops after the join instead of reconnecting', async () => {
		const channel = new FakeChannel();
		const room = await joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel) as unknown as WebSocket });
		let closed = 0;
		room.onClose(() => (closed += 1));
		socketsOf(channel)[0].drop();
		expect(closed).toBe(1);
	});

	it('closes the socket and forgets its handlers when the room is closed', async () => {
		const channel = new FakeChannel();
		const room = await joinRoom('ws://x', 'r1', { makeSocket: () => new FakeSocket(channel) as unknown as WebSocket });
		let closed = 0;
		room.onClose(() => (closed += 1));
		room.close();
		expect(socketsOf(channel)[0].closed).toBe(true);
		socketsOf(channel)[0].drop();
		// A close the room itself asked for is not an event the screen hears about.
		expect(closed).toBe(0);
	});
});
