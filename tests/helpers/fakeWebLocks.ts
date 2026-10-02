type LockCallback = (lock: { name: string } | null) => unknown;

export interface FakeLockManager {
	request(name: string, optionsOrCallback: unknown, maybeCallback?: LockCallback): Promise<unknown>;
	held(name: string): boolean;
}

export function makeFakeLockManager(): FakeLockManager {
	const tails = new Map<string, Promise<void>>();
	const holders = new Map<string, number>();
	return {
		async request(name, optionsOrCallback, maybeCallback) {
			const hasOptions = typeof optionsOrCallback !== 'function';
			const options = (hasOptions ? optionsOrCallback : {}) as { ifAvailable?: boolean };
			const callback = (hasOptions ? maybeCallback : optionsOrCallback) as LockCallback;
			if (options.ifAvailable && tails.has(name)) return callback(null);
			const previous = tails.get(name) ?? Promise.resolve();
			let release!: () => void;
			const hold = new Promise<void>((resolve) => { release = resolve; });
			tails.set(name, hold);
			await previous;
			holders.set(name, (holders.get(name) ?? 0) + 1);
			try {
				return await callback({ name });
			} finally {
				holders.set(name, (holders.get(name) ?? 1) - 1);
				release();
				if (tails.get(name) === hold) tails.delete(name);
			}
		},
		held: (name) => (holders.get(name) ?? 0) > 0,
	};
}
