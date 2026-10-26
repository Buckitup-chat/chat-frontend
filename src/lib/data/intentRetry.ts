// Pacing of intent recovery for one signed-in account.
//
// An intent the recovery pass cannot finish now (a dialog key unreadable while
// offline, a storage base not yet proven) stays stored and "waits for
// recovery". Login, the browser's 'online' event and the tab becoming visible
// start a pass, but none of them proves the server is reachable: 'online' can
// fire while DNS or the server still fail, and a tab that stays in front never
// becomes visible again. So, as the outbox does for its writes (ADR §5), a
// pass that leaves intents waiting schedules the next one itself, with growing
// pauses; and after an intent was left waiting outside a pass (the send path
// failed), the first answer from the server starts one at once.

export interface RecoveryPassResult {
	/** Intents the pass left stored for a later attempt. */
	waiting: number;
}

export interface RecoveryScheduler {
	/** Run a pass now, or right after the one in flight. */
	trigger(): void;
	/** An intent was just left for recovery outside a pass: retry it after a pause. */
	intentWaiting(): void;
	/** The server answered a request: if an intent was left waiting since, run a pass now. */
	serverAnswered(): void;
	/** The account signed out: no more passes. */
	stop(): void;
}

const waitingListeners = new Set<(userHash: string) => void>();

// Every tab of the account runs its own scheduler, so a tab that left an
// intent tells the others too (intents are shared storage).
const waitingChannel: BroadcastChannel | null =
	typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('buckitup-intent-waiting') : null;

const deliverWaiting = (userHash: string) => {
	for (const handler of waitingListeners) {
		try {
			handler(userHash);
		} catch (e) {
			console.warn('[intents] onIntentWaiting subscriber threw:', e);
		}
	}
};

waitingChannel?.addEventListener('message', (ev: MessageEvent<{ userHash?: string }>) => {
	if (typeof ev.data?.userHash === 'string') deliverWaiting(ev.data.userHash);
});

/** Report that an intent of this account was left stored for recovery. */
export function noteIntentWaiting(userHash: string): void {
	deliverWaiting(userHash);
	waitingChannel?.postMessage({ userHash });
}

export function onIntentWaiting(handler: (userHash: string) => void): () => void {
	waitingListeners.add(handler);
	return () => waitingListeners.delete(handler);
}

const answeredListeners = new Set<() => void>();

/** A write got an answer from the server below 500: the connection is proven. */
export function notifyServerAnswered(): void {
	for (const handler of answeredListeners) {
		try {
			handler();
		} catch (e) {
			console.warn('[intents] onServerAnswered subscriber threw:', e);
		}
	}
}

export function onServerAnswered(handler: () => void): () => void {
	answeredListeners.add(handler);
	return () => answeredListeners.delete(handler);
}

// The outbox's pacing for writes that wait on the connection (outbox.ts
// RETRY_BASE_MS, RETRY_NETWORK_MAX_MS): what an intent waits for is mostly the
// connection too.
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 30_000;

export function createRecoveryScheduler(
	run: () => Promise<RecoveryPassResult | void>,
	opts: { baseMs?: number; maxMs?: number } = {},
): RecoveryScheduler {
	const baseMs = opts.baseMs ?? RETRY_BASE_MS;
	const maxMs = opts.maxMs ?? RETRY_MAX_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let failures = 0;
	let running = false;
	let rerun = false;
	let waiting = false;
	let notedDuringPass = false;
	let stopped = false;
	// Set when an intent is left waiting outside a pass: the next server answer
	// then runs a pass at once, once. An intent a pass keeps leaving waits for
	// something an answer does not bring; the timer and its growing pause have it.
	let answerArmed = false;

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};

	const schedule = () => {
		clearTimer();
		const delay = Math.min(baseMs * 2 ** failures, maxMs) + Math.floor(Math.random() * 1_000);
		failures++;
		timer = setTimeout(() => {
			timer = null;
			void pass();
		}, delay);
	};

	const pass = async (): Promise<void> => {
		if (stopped) return;
		if (running) {
			rerun = true;
			return;
		}
		running = true;
		notedDuringPass = false;
		clearTimer();
		let result: RecoveryPassResult | void;
		try {
			result = await run();
		} catch (e) {
			console.warn('[intents] recovery pass failed, will retry:', e);
			result = { waiting: 1 };
		} finally {
			running = false;
		}
		if (stopped) return;
		waiting = (result?.waiting ?? 0) > 0 || notedDuringPass;
		if (rerun) {
			rerun = false;
			void pass();
			return;
		}
		if (waiting) schedule();
		else failures = 0;
	};

	return {
		trigger: () => void pass(),
		intentWaiting: () => {
			if (stopped) return;
			waiting = true;
			answerArmed = true;
			if (running) notedDuringPass = true;
			else if (!timer) schedule();
		},
		serverAnswered: () => {
			if (!answerArmed || stopped) return;
			answerArmed = false;
			failures = 0;
			void pass();
		},
		stop: () => {
			stopped = true;
			clearTimer();
		},
	};
}
