// The part of a device-link screen that is not the screen: joining the room,
// tearing it down on every exit path, and turning a failure into a stage.
// Both link modals sit on this, so liveness and cleanup rules are written once.
import { ref, shallowRef, onUnmounted } from 'vue';
import { joinRoom, roomSocketUrl } from '@/lib/deviceLink/room';

export function useLinkRoom() {
	const stage = ref('');
	const error = ref('');
	const session = shallowRef(null);

	let room = null;
	let joining = null;
	let onTeardown = () => {};

	/** Close the room, forget the session, run the screen's own cleanup. Twice is fine. */
	const teardown = () => {
		joining?.abort();
		joining = null;
		room?.close();
		room = null;
		session.value?.key.fill(0);
		session.value?.macKey.fill(0);
		session.value = null;
		onTeardown();
	};

	const fail = (message) => {
		teardown();
		error.value = message;
		stage.value = 'error';
	};

	/**
	 * Join the room and wire the handlers. Resolves to the room, or null when
	 * the screen was torn down while the join was in flight - in which case
	 * nothing is left running and the caller has nothing to do.
	 */
	const join = async (roomId, handlers) => {
		const controller = (joining = new AbortController());
		let joined;
		try {
			joined = await joinRoom(roomSocketUrl(API_URL), roomId, { signal: controller.signal });
		} catch (e) {
			if (!controller.signal.aborted) fail(`Could not reach the server: ${e.message}`);
			return null;
		}
		if (controller.signal.aborted) {
			joined.close();
			return null;
		}
		joining = null;
		room = joined;
		room.onMessage(handlers.onMessage);
		if (handlers.onJoin) room.onJoin(handlers.onJoin);
		room.onLeave((who) => handlers.onLeave?.(who));
		room.onClose(() => handlers.onClose?.());
		return room;
	};

	const send = (data) => room?.send(data);

	onUnmounted(teardown);

	return {
		stage,
		error,
		session,
		join,
		send,
		fail,
		teardown,
		/** The screen's own cleanup - a scanner, a timer, a KEM secret - run inside teardown. */
		setCleanup: (fn) => (onTeardown = fn),
	};
}
