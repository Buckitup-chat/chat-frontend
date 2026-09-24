// A room on the backend's WebRTC signaling socket, spoken directly.
//
// The socket is a Phoenix channel (chat: lib/chat_web/channels/webrtc_channel.ex)
// and this is the subset of its wire protocol two devices need to find each
// other: join a topic, push a "signal" event, receive the "signal" events the
// channel rebroadcasts to everyone else in the room, keep the heartbeat going.
// The room carries public keys and ciphertext only, and the id is 128 random
// bits from the invite; nothing here is trusted. The `phoenix` client library
// would do this too — it is four thousand lines for the sixty this needs, and
// it reconnects on its own, which a one-shot session must not: a socket that
// drops mid-link is reported to the screen, not papered over.
//
// Wire format (protocol v2): every frame is a JSON array
//   [join_ref, ref, topic, event, payload]
// and a reply to a push is the event "phx_reply" carrying the push's ref.

export interface Room {
	/** Broadcast a payload to everyone else in the room. */
	send(data: unknown): void;
	/**
	 * What the others broadcast, with the channel's id for the sender. The id is
	 * what lets a screen pin the one peer it is talking to and ignore anyone else
	 * who found the room. One handler; the screen is the only listener.
	 */
	onMessage(handler: (data: unknown, from: string) => void): void;
	/** Another device joined — the cue to resend anything it may have missed. */
	onJoin(handler: () => void): void;
	/** A member left the room. */
	onLeave(handler: (who: string) => void): void;
	/** The socket or the channel went away after the join. Nothing reconnects; the screen decides. */
	onClose(handler: () => void): void;
	close(): void;
}

export interface JoinOptions {
	/** Abort while the join is pending: the socket is closed and the promise rejects. */
	signal?: AbortSignal;
	/** The socket constructor, so a test can stand in a fake that honours the protocol. */
	makeSocket?: (url: string) => WebSocket;
}

const HEARTBEAT_MS = 30_000;
/** A server that accepts the socket and never answers the join is not one worth waiting on. */
const JOIN_TIMEOUT_MS = 15_000;

/** The socket URL for an API base: http(s) becomes ws(s), and the path is the channel's. */
export const roomSocketUrl = (apiBase: string): string =>
	`${apiBase.replace(/^http/, 'ws').replace(/\/$/, '')}/webrtc-socket/websocket?vsn=2.0.0`;

/** Join `room:<id>` and resolve once the channel has accepted the join. */
export const joinRoom = (url: string, roomId: string, options: JoinOptions = {}): Promise<Room> =>
	new Promise((resolve, reject) => {
		const topic = `room:${roomId}`;
		const socket = (options.makeSocket ?? ((u) => new WebSocket(u)))(url);
		let onMessage: (data: unknown, from: string) => void = () => {};
		let onJoin: () => void = () => {};
		let onLeave: (who: string) => void = () => {};
		let onClose: () => void = () => {};
		let ref = 0;
		let joinRef = '';
		let joined = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let joinDeadline: ReturnType<typeof setTimeout> | undefined;
		// The ref of the heartbeat still awaiting its reply. A dead TCP stream
		// never closes on its own; a missed reply is how it shows.
		let pendingBeat: string | null = null;

		const frame = (frameJoinRef: string | null, frameTopic: string, event: string, payload: unknown) => {
			ref += 1;
			socket.send(JSON.stringify([frameJoinRef, String(ref), frameTopic, event, payload]));
			return String(ref);
		};

		const stop = () => {
			clearInterval(heartbeat);
			clearTimeout(joinDeadline);
			socket.close();
		};

		const fail = (why: string) => {
			clearInterval(heartbeat);
			clearTimeout(joinDeadline);
			if (joined) onClose();
			else reject(new Error(why));
		};

		const beat = () => {
			if (pendingBeat !== null) {
				// The previous beat was never answered: the socket is open in
				// name only. Report it as the close it effectively is.
				fail('socket closed');
				socket.close();
				return;
			}
			pendingBeat = frame(null, 'phoenix', 'heartbeat', {});
		};

		options.signal?.addEventListener('abort', () => {
			fail('aborted');
			socket.close();
		});

		socket.onopen = () => {
			// The join frame carries its own ref as join_ref; nothing is known before it.
			joinRef = frame(null, topic, 'phx_join', {});
			heartbeat = setInterval(beat, HEARTBEAT_MS);
			joinDeadline = setTimeout(() => {
				fail('join timed out');
				socket.close();
			}, JOIN_TIMEOUT_MS);
		};

		socket.onmessage = (event: MessageEvent) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (!Array.isArray(parsed) || parsed.length !== 5) return;
			const [, replyRef, frameTopic, name, payload] = parsed as [unknown, string | null, string, string, Record<string, unknown>];

			if (name === 'phx_reply' && replyRef === pendingBeat) {
				pendingBeat = null;
				return;
			}
			if (name === 'phx_reply' && replyRef === joinRef && !joined) {
				if (payload?.status === 'ok') {
					joined = true;
					clearTimeout(joinDeadline);
					resolve({
						send: (data) => frame(joinRef, topic, 'signal', { to: '*', type: 'device-link', data }),
						onMessage: (h) => (onMessage = h),
						onJoin: (h) => (onJoin = h),
						onLeave: (h) => (onLeave = h),
						onClose: (h) => (onClose = h),
						close: () => {
							onMessage = () => {};
							onJoin = () => {};
							onLeave = () => {};
							onClose = () => {};
							stop();
						},
					});
				} else {
					fail(`join refused: ${JSON.stringify(payload?.response ?? payload)}`);
					socket.close();
				}
				return;
			}
			if (frameTopic !== topic) return;
			if (name === 'signal' && payload?.type === 'device-link') onMessage(payload.data, String(payload.from));
			else if (name === 'user_joined') onJoin();
			else if (name === 'user_left') onLeave(String(payload?.user_id));
			// The channel process itself going away: the socket may stay up, but
			// the room is gone, and for this screen that is the same event.
			else if (name === 'phx_close' || name === 'phx_error') fail('channel closed');
		};

		socket.onerror = () => fail('socket error');
		socket.onclose = () => fail('socket closed');
	});
