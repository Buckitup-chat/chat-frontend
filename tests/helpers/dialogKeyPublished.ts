export const markDialogKeyPublishedHere = async (userHash: string, dialogHash: string): Promise<void> =>
	(await import('@/lib/data/localStore')).kvSet(`dialog-key-published-here:${userHash}|${dialogHash}`, true, userHash);

export const useMemoryLocalStore = async (): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	(await import('@/lib/data/localStore'))._setStoreForTests({
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => { map.set(k, v); },
		delete: async (k) => { map.delete(k); },
		keys: async () => [...map.keys()],
		clear: async () => { map.clear(); },
	});
	return map;
};
