// An in-memory backing for lib/avatars/localStore, sealed for real under a
// key per account — what a test sees in `raw` is what the device would hold.
import { _setAvatarLocalStoreForTests } from '@/lib/avatars/localStore';

export const useMemoryAvatarStore = () => {
	const raw = new Map<string, string>();
	const keys = new Map<string, Promise<CryptoKey>>();
	const keyFor = (owner: string) => {
		if (!keys.has(owner)) keys.set(owner, crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>);
		return keys.get(owner)!;
	};
	_setAvatarLocalStoreForTests({
		get: async (k) => raw.get(k) ?? null,
		set: async (k, v) => { raw.set(k, v); },
		delete: async (k) => { raw.delete(k); },
		keys: async () => [...raw.keys()],
		clear: async () => { raw.clear(); },
	}, keyFor);
	return raw;
};
