// Runs `fn` after every earlier run under the same key has settled, failed
// ones included; resolves or rejects as `fn` does. The map holds one tail per
// key and forgets it once nothing more is queued.
export const serialized = <T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => T | Promise<T>): Promise<T> => {
	const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
	const settledRun = run.then(() => undefined, () => undefined);
	locks.set(key, settledRun);
	void settledRun.then(() => { if (locks.get(key) === settledRun) locks.delete(key); });
	return run;
};
