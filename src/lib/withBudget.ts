/** `promise`, or a rejection once `ms` pass first: one slow read must not wedge what waits on it. */
export const withBudget = <T>(promise: Promise<T>, ms: number, label = 'read'): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} budget exceeded`)), ms); }),
	]).finally(() => clearTimeout(timer));
};
