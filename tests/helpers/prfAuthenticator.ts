export type PrfSupport =
	| 'at-create'
	| 'at-get'
	| 'none'
	| 'browser-none';

export interface AuthenticatorOptions {
	second?: boolean;
	backupEligible?: boolean;
	backupState?: boolean;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const bytesOf = (source: BufferSource): Uint8Array =>
	ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source);

const hmac = async (secret: Uint8Array<ArrayBuffer>, salt: Uint8Array): Promise<ArrayBuffer> => {
	const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return crypto.subtle.sign('HMAC', key, new Uint8Array(salt));
};

const notAllowed = (message: string) => new DOMException(message, 'NotAllowedError');

const authenticatorData = ({ backupEligible, backupState }: AuthenticatorOptions): ArrayBuffer => {
	const data = new Uint8Array(37);
	data[32] = 0x01 | 0x04 | (backupEligible ? 0x08 : 0) | (backupState ? 0x10 : 0);
	return data.buffer;
};

export const prfAuthenticator = (support: PrfSupport = 'at-create', options: AuthenticatorOptions = {}) => {
	const { second: answersSecond = true, backupEligible = true, backupState = true } = options;
	const secrets = new Map<string, Uint8Array<ArrayBuffer>>();
	const calls: Array<'create' | 'get'> = [];
	let refuseNext = false;
	let chosen: string | null = null;

	const credentials = {
		async create(options?: CredentialCreationOptions) {
			calls.push('create');
			if (refuseNext) { refuseNext = false; throw notAllowed('cancelled'); }
			const pk = options!.publicKey!;
			if (pk.authenticatorSelection?.userVerification !== 'required') throw new Error('test authenticator: PRF needs UV required');
			const rawId = crypto.getRandomValues(new Uint8Array(16));
			const secret = crypto.getRandomValues(new Uint8Array(32));
			secrets.set(b64(rawId), secret);
			const salt = pk.extensions?.prf?.eval?.first;
			let prf: AuthenticationExtensionsPRFOutputs | undefined;
			if (support === 'at-create') prf = { enabled: true, results: { first: await hmac(secret, bytesOf(salt!)) } };
			else if (support === 'at-get') prf = { enabled: true };
			else if (support === 'none') prf = { enabled: false };
			return {
				rawId: rawId.buffer,
				response: { getTransports: () => ['internal'] },
				getClientExtensionResults: () => (prf ? { prf } : {}),
			} as unknown as PublicKeyCredential;
		},
		async get(options?: CredentialRequestOptions) {
			calls.push('get');
			if (refuseNext) { refuseNext = false; throw notAllowed('cancelled'); }
			const pk = options!.publicKey!;
			if (pk.userVerification !== 'required') throw new Error('test authenticator: PRF needs UV required');
			const allowed = pk.allowCredentials?.[0];
			const id = allowed ? b64(bytesOf(allowed.id)) : (chosen ?? [...secrets.keys()].at(-1) ?? null);
			const secret = id ? secrets.get(id) : undefined;
			if (!id || !secret) throw notAllowed('no matching credential');
			const salts = pk.extensions?.prf?.eval;
			let prf: AuthenticationExtensionsPRFOutputs | undefined;
			if (support === 'browser-none') prf = undefined;
			else if (support === 'none' || !salts?.first) prf = {};
			else {
				prf = { results: { first: await hmac(secret, bytesOf(salts.first)) } };
				if (salts.second && answersSecond) prf.results!.second = await hmac(secret, bytesOf(salts.second));
			}
			return {
				rawId: Uint8Array.from(atob(id), (c) => c.charCodeAt(0)).buffer,
				response: { authenticatorData: authenticatorData({ backupEligible, backupState }) },
				getClientExtensionResults: () => (prf ? { prf } : {}),
			} as unknown as PublicKeyCredential;
		},
	};

	return {
		credentials,
		calls,
		refuseNext: () => { refuseNext = true; },
		choose: (credentialId: string | null) => { chosen = credentialId; },
		credentialIds: () => [...secrets.keys()],
	};
};
