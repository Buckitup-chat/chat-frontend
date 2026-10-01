export class VaultLockedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'VaultLockedError';
	}
}

export type SigningKeySource = Uint8Array | (() => Promise<Uint8Array>);

export const resolveSigningKey = async (source: SigningKeySource): Promise<Uint8Array> =>
	typeof source === 'function' ? source() : source;

export class AccountMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AccountMismatchError';
	}
}
