// Runs `fn` after every earlier run under the same key has settled, failed
// ones included; resolves or rejects as `fn` does. The map holds one tail per
// key and forgets it as the last run queued settles, before its caller resumes.
export const serialized = <T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => T | Promise<T>): Promise<T> => {
	const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
	const forget = () => { if (locks.get(key) === settledRun) locks.delete(key); };
	const settledRun: Promise<void> = run.then(forget, forget);
	locks.set(key, settledRun);
	return run;
};

const inProcessLocks = new Map<string, Promise<unknown>>();

const withCrossTabLock = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks?.request) return fn();
	return locks.request(name, () => fn());
};

/**
 * Runs `fn` alone under `name`: queued behind earlier calls in this tab,
 * and under the Web Lock of that name across tabs where there is one.
 */
export const withNamedLock = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
	serialized(inProcessLocks, name, () => withCrossTabLock(name, fn));

/**
 * Runs `fn` under `name` as withNamedLock does, only if nobody holds or waits
 * for that lock, in this tab or another. Resolves to whether `fn` ran;
 * rejects as `fn` does.
 */
export const tryNamedLock = (name: string, fn: () => Promise<void>): Promise<boolean> => {
	if (inProcessLocks.has(name)) return Promise.resolve(false);
	return serialized(inProcessLocks, name, async () => {
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		if (!locks?.request) {
			await fn();
			return true;
		}
		return locks.request(name, { ifAvailable: true }, async (lock) => {
			if (!lock) return false;
			await fn();
			return true;
		});
	});
};
