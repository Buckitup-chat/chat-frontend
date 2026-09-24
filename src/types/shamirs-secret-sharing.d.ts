declare module 'shamirs-secret-sharing' {
	interface SplitOptions {
		shares: number;
		threshold: number;
	}

	function split(secret: Buffer | Uint8Array, options: SplitOptions): Buffer[];
	function combine(shares: Array<Buffer | Uint8Array>): Buffer;

	const sss: { split: typeof split; combine: typeof combine };
	export default sss;
}
