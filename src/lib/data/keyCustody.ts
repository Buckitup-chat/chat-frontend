export { VaultLockedError } from '@buckitup/pq-client/vault';

export type SigningKeySource = Uint8Array | (() => Promise<Uint8Array>);

export const resolveSigningKey = async (source: SigningKeySource): Promise<Uint8Array> =>
	typeof source === 'function' ? source() : source;

export class AccountMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AccountMismatchError';
	}
}
