import { hkdfDerive } from './hkdf.js';
import { toBase64, fromBase64 } from './signature.js';

export const VAULT_LOCK_VERSION = 1;
export const VAULT_LOCK_SALT = 'buckitup/vault-lock/v1';
const LOCK_SEED_INFO = 'local-data-lock seed';
const CEREMONY_TIMEOUT_MS = 120_000;

export interface PrfLockRecord {
	v: typeof VAULT_LOCK_VERSION;
	credentialId: string;
	salt: string;
	rpId: string;
	transports: string[];
}

export class PrfUnsupportedError extends Error {
	constructor(readonly credentialId: string, readonly reason: 'browser' | 'authenticator') {
		super(`WebAuthn PRF is not supported by this ${reason}`);
		this.name = 'PrfUnsupportedError';
	}
}

export class PrfMissingError extends Error {
	constructor() {
		super('The passkey did not return the value that opens this vault');
		this.name = 'PrfMissingError';
	}
}

export class PasskeyMismatchError extends Error {
	constructor() {
		super('The passkey that answered is not the one this vault is locked with');
		this.name = 'PasskeyMismatchError';
	}
}

export type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

const bufferOf = (b64: string): Uint8Array<ArrayBuffer> => new Uint8Array(fromBase64(b64));

const viewOf = (source: BufferSource): Uint8Array =>
	ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source);

export const lockSeedFromPrf = (prf: Uint8Array): Uint8Array => {
	if (prf.length !== 32) throw new PrfMissingError();
	return hkdfDerive(prf, VAULT_LOCK_SALT, LOCK_SEED_INFO);
};

export const newLockSalt = (): Uint8Array<ArrayBuffer> => randomBytes(32);

export const lockRecordFor = ({ credentialId, rpId, transports = [], salt = newLockSalt() }: {
	credentialId: string; rpId: string; transports?: string[]; salt?: Uint8Array;
}): PrfLockRecord => ({
	v: VAULT_LOCK_VERSION,
	credentialId,
	salt: toBase64(salt),
	rpId,
	transports,
});

export const lockSaltOf = (record: PrfLockRecord): Uint8Array<ArrayBuffer> => bufferOf(record.salt);

const seedOf = (prf: AuthenticationExtensionsPRFOutputs | undefined): Uint8Array | null => {
	const first = prf?.results?.first;
	if (!first) return null;
	const value = viewOf(first);
	try {
		return lockSeedFromPrf(value);
	} finally {
		value.fill(0);
		if (prf?.results?.second) viewOf(prf.results.second).fill(0);
	}
};

const creationOptions = (
	{ rpId, vaultId, name }: { rpId: string; vaultId: string; name: string },
	salt: Uint8Array<ArrayBuffer>,
): CredentialCreationOptions => ({
	publicKey: {
		rp: { id: rpId, name: 'BuckitUp' },
		user: { id: new TextEncoder().encode(vaultId), name, displayName: name },
		challenge: randomBytes(32),
		pubKeyCredParams: [
			{ type: 'public-key', alg: -8 },
			{ type: 'public-key', alg: -7 },
			{ type: 'public-key', alg: -257 },
		],
		authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
		attestation: 'none',
		timeout: CEREMONY_TIMEOUT_MS,
		extensions: { prf: { eval: { first: salt } } },
	},
});

export const backupFlagsOf = (authenticatorData: ArrayBuffer | undefined): { backupEligible: boolean; backupState: boolean } | null => {
	if (!authenticatorData || authenticatorData.byteLength < 33) return null;
	const flags = new Uint8Array(authenticatorData)[32];
	return { backupEligible: (flags & 0x08) !== 0, backupState: (flags & 0x10) !== 0 };
};

export interface PrfAssertion {
	credentialId: string;
	first: Uint8Array;
	second: Uint8Array | null;
	flags: { backupEligible: boolean; backupState: boolean } | null;
}

export const assertPrf = async (
	credentials: Credentials,
	{ rpId, credentialId = null, transports = [], first, second }: {
		rpId: string;
		credentialId?: string | null;
		transports?: string[];
		first: Uint8Array<ArrayBuffer>;
		second?: Uint8Array<ArrayBuffer>;
	},
): Promise<PrfAssertion> => {
	const credential = (await credentials.get({
		publicKey: {
			challenge: randomBytes(32),
			rpId,
			...(credentialId ? {
				allowCredentials: [{
					type: 'public-key',
					id: bufferOf(credentialId),
					...(transports.length ? { transports: transports as AuthenticatorTransport[] } : {}),
				}],
			} : {}),
			userVerification: 'required',
			timeout: CEREMONY_TIMEOUT_MS,
			extensions: { prf: { eval: second ? { first, second } : { first } } },
		},
	})) as PublicKeyCredential | null;
	if (!credential) throw new PrfMissingError();
	const results = credential.getClientExtensionResults().prf?.results;
	const wipe = () => {
		if (results?.first) viewOf(results.first).fill(0);
		if (results?.second) viewOf(results.second).fill(0);
	};
	const answered = toBase64(new Uint8Array(credential.rawId));
	if (credentialId && answered !== toBase64(bufferOf(credentialId))) {
		wipe();
		throw new PasskeyMismatchError();
	}
	if (!results?.first || viewOf(results.first).length !== 32) {
		wipe();
		throw new PrfMissingError();
	}
	const out: PrfAssertion = {
		credentialId: answered,
		first: new Uint8Array(viewOf(results.first)),
		second: results.second ? new Uint8Array(viewOf(results.second)) : null,
		flags: backupFlagsOf((credential.response as AuthenticatorAssertionResponse).authenticatorData),
	};
	wipe();
	return out;
};

export const readLockSeed = async (credentials: Credentials, record: PrfLockRecord): Promise<Uint8Array> => {
	const answer = await assertPrf(credentials, {
		rpId: record.rpId, credentialId: record.credentialId, transports: record.transports, first: lockSaltOf(record),
	});
	try {
		return lockSeedFromPrf(answer.first);
	} finally {
		answer.first.fill(0);
		answer.second?.fill(0);
	}
};

export const createPrfPasskey = async (
	credentials: Credentials,
	{ rpId, vaultId, name }: { rpId: string; vaultId: string; name: string },
): Promise<{ record: PrfLockRecord; seed: Uint8Array }> => {
	const salt = randomBytes(32);
	const credential = (await credentials.create(creationOptions({ rpId, vaultId, name }, salt))) as PublicKeyCredential | null;
	if (!credential) throw new Error('Passkey creation returned no credential');
	const response = credential.response as AuthenticatorAttestationResponse;
	const record: PrfLockRecord = {
		v: VAULT_LOCK_VERSION,
		credentialId: toBase64(new Uint8Array(credential.rawId)),
		salt: toBase64(salt),
		rpId,
		transports: response.getTransports?.() ?? [],
	};
	const prf = credential.getClientExtensionResults().prf;
	if (!prf) throw new PrfUnsupportedError(record.credentialId, 'browser');
	const seed = seedOf(prf);
	if (seed) return { record, seed };
	if (prf.enabled === false) throw new PrfUnsupportedError(record.credentialId, 'authenticator');
	try {
		return { record, seed: await readLockSeed(credentials, record) };
	} catch (e) {
		if (e instanceof PrfMissingError) throw new PrfUnsupportedError(record.credentialId, 'authenticator');
		throw e;
	}
};

export const forgetUnusablePasskey = (credentialId: string, rpId = typeof location !== 'undefined' ? location.hostname : ''): void => {
	type Signal = (options: { rpId: string; credentialId: string }) => Promise<void>;
	const signal = typeof PublicKeyCredential !== 'undefined'
		? (PublicKeyCredential as unknown as { signalUnknownCredential?: Signal }).signalUnknownCredential
		: undefined;
	if (!signal || !credentialId) return;
	const base64url = credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	signal.call(PublicKeyCredential, { rpId, credentialId: base64url }).catch(() => {});
};
