// The storage rawStorage('idb') in @lo-fi/local-vault returns.
declare module '@byojs/storage/idb' {
	const storage: {
		storageType: 'idb';
		has(name: string): Promise<boolean>;
		get(name: string): Promise<unknown>;
		set(name: string, value: unknown): Promise<boolean>;
		remove(name: string): Promise<boolean>;
		keys(): Promise<string[]>;
		entries(): Promise<[string, unknown][]>;
	};
	export default storage;
}
