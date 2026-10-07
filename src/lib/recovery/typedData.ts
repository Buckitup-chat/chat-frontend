// EIP-712 signatures for the recovery contracts. The typed data is the SDK's
// (backitup-secret-recovery-sdk, pinned there to the contracts' typehashes);
// this file adds the deployment — chain and addresses — and signs with ethers,
// which takes the types a primary type reaches rather than the whole table.
import { Wallet, type TypedDataField } from 'ethers';
import {
	KEY_REGISTRY_DOMAIN,
	SECRET_RECOVERY_DOMAIN,
	TYPES,
	type TypedDataPrimaryType,
	type TypedMessages,
} from 'backitup-secret-recovery-sdk/lib/contract/typedData';
import { secretIdOf, type Deployment } from './deployments';
import type { RecoveryChain, SecretState } from './chain';

export type Signable = Exclude<TypedDataPrimaryType, 'Share'>;
export type SignedContract = 'secretRecovery' | 'keyRegistry';

/** The contract that verifies a payload; InvalidateNonce is verified by either, and the caller names it. */
const contractOf = (primaryType: Signable): SignedContract => (primaryType === 'RegisterKeys' ? 'keyRegistry' : 'secretRecovery');

export const domainOf = (deployment: Deployment, contract: SignedContract) =>
	contract === 'keyRegistry'
		? { ...KEY_REGISTRY_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.keyRegistry }
		: { ...SECRET_RECOVERY_DOMAIN, chainId: deployment.chainId, verifyingContract: deployment.secretRecovery };

const structOf = (type: string): string => type.replace(/\[\]$/, '');

/** The primary type and every struct it reaches: what ethers hashes. */
export const typesFor = (primaryType: Signable): Record<string, TypedDataField[]> => {
	const out: Record<string, TypedDataField[]> = {};
	const visit = (name: string) => {
		if (out[name] || !(name in TYPES)) return;
		out[name] = TYPES[name as keyof typeof TYPES].map((f) => ({ name: f.name, type: f.type }));
		for (const f of out[name]) visit(structOf(f.type));
	};
	visit(primaryType);
	return out;
};

// The contract caps `deadline` at MAX_SIGNATURE_LIFETIME (a day) past the
// executing block; an hour leaves room for a slow relayer.
const SIGNATURE_LIFETIME_SEC = 3600;
export const newDeadline = (nowSeconds = Math.floor(Date.now() / 1000)): bigint => BigInt(nowSeconds + SIGNATURE_LIFETIME_SEC);

/**
 * Once per deployment and contract, before the first signature: a signature
 * under a domain the contract does not have is refused only at submission,
 * as a bare InvalidSignature. A wrong address or deployment stops here.
 */
const checkedDomains = new Map<string, Promise<void>>();
const checkDomain = (chain: RecoveryChain, contract: SignedContract): Promise<void> => {
	const key = `${chain.deployment.chainId}:${contract}`;
	let checked = checkedDomains.get(key);
	if (!checked) {
		const want = domainOf(chain.deployment, contract);
		checked = chain.eip712Domain(contract).then((got) => {
			if (got.name !== want.name || got.version !== want.version || Number(got.chainId) !== want.chainId) {
				throw new Error(
					`${want.verifyingContract} signs as ${got.name} v${got.version} on chain ${got.chainId}; ` +
						`this client signs as ${want.name} v${want.version} on chain ${want.chainId}`,
				);
			}
		});
		// A failed read is asked again next time.
		checked.catch(() => checkedDomains.delete(key));
		checkedDomains.set(key, checked);
	}
	return checked;
};

/**
 * A signature by `privateKey` over `message` of `primaryType`, under the
 * domain of `contract` in the deployment — for InvalidateNonce, the contract
 * whose nonce it burns.
 */
export const signTyped = async <P extends Signable>(
	chain: RecoveryChain,
	privateKey: string,
	primaryType: P,
	message: TypedMessages[P],
	contract: SignedContract = contractOf(primaryType),
): Promise<string> => {
	await checkDomain(chain, contract);
	return new Wallet(privateKey).signTypedData(domainOf(chain.deployment, contract), typesFor(primaryType), message as unknown as Record<string, unknown>);
};

/**
 * Signs the creation of secret `fields.label` by the key's address, its
 * owner. The nonce is keyed by the id the secret will have, and read right
 * before the signature.
 */
export const signAddSecret = async (
	chain: RecoveryChain,
	privateKey: string,
	fields: Omit<TypedMessages['AddSecret'], 'nonce' | 'deadline'>,
): Promise<{ id: string; signer: string; signature: string; deadline: bigint }> => {
	const signer = new Wallet(privateKey).address;
	const id = secretIdOf(signer, fields.label);
	const nonce = await chain.nonce(signer, id);
	const deadline = newDeadline();
	return { id, signer, signature: await signTyped(chain, privateKey, 'AddSecret', { ...fields, nonce, deadline }), deadline };
};

/** The payloads about an existing secret: each carries `version` and `round`, which the contract hashes from storage. */
export type BoundType = { [K in Signable]: 'version' extends keyof TypedMessages[K] ? K : never }[Signable];
type BoundFields<P extends BoundType> = Omit<TypedMessages[P], 'id' | 'version' | 'round' | 'nonce' | 'deadline'>;

/**
 * Signs a payload about secret `id` as `signer`: the secret and the signer's
 * nonce for it are read together, right before the signature, since the
 * contract checks both against storage at execution. For InitiateRecovery
 * `round` is the stored one, before the initiation increments it.
 */
export const signBound = async <P extends BoundType>(
	chain: RecoveryChain,
	privateKey: string,
	signer: string,
	primaryType: P,
	id: string,
	fields: BoundFields<P>,
): Promise<{ signature: string; deadline: bigint; secret: SecretState }> => {
	const [secret, nonce] = await Promise.all([chain.readSecret(id), chain.nonce(signer, id)]);
	if (!secret) throw new Error(`no secret ${id} on chain ${chain.deployment.chainId}`);
	const deadline = newDeadline();
	const message = { ...fields, id, version: secret.version, round: secret.recoveryRound, nonce, deadline } as unknown as TypedMessages[P];
	return { signature: await signTyped(chain, privateKey, primaryType, message), deadline, secret };
};
