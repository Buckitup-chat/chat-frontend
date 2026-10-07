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
import { secretIdOf, type Deployment, type RecoveryContract } from './deployments';
import type { RecoveryChain, SecretState } from './chain';
import type { Bodies } from './gateway';

export type Signable = Exclude<TypedDataPrimaryType, 'Share'>;

const DOMAINS = { secretRecovery: SECRET_RECOVERY_DOMAIN, keyRegistry: KEY_REGISTRY_DOMAIN };

export const domainOf = (deployment: Deployment, contract: RecoveryContract) => ({
	...DOMAINS[contract],
	chainId: deployment.chainId,
	verifyingContract: deployment[contract],
});

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
 * Once per chain client and contract, before the first signature: a
 * signature under a domain the contract does not have is refused only at
 * submission, as a bare InvalidSignature. A wrong address or deployment stops here.
 */
const checkedDomains = new WeakMap<RecoveryChain, Map<RecoveryContract, Promise<void>>>();
const checkDomain = (chain: RecoveryChain, contract: RecoveryContract): Promise<void> => {
	const byContract = checkedDomains.get(chain) ?? new Map<RecoveryContract, Promise<void>>();
	checkedDomains.set(chain, byContract);
	let checked = byContract.get(contract);
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
		checked.catch(() => byContract.delete(contract));
		byContract.set(contract, checked);
	}
	return checked;
};

/** InvalidateNonce is verified by either contract and names the one whose nonce it burns; every other payload has one. */
type ContractOf<P extends Signable> = P extends 'InvalidateNonce' ? [contract: RecoveryContract] : [];

/** A signature by `privateKey` over `message` of `primaryType`, under the domain of the contract that verifies it. */
export const signTyped = async <P extends Signable>(
	chain: RecoveryChain,
	privateKey: string,
	primaryType: P,
	message: TypedMessages[P],
	...[named]: ContractOf<P>
): Promise<string> => {
	const contract: RecoveryContract = named ?? (primaryType === 'RegisterKeys' ? 'keyRegistry' : 'secretRecovery');
	await checkDomain(chain, contract);
	return new Wallet(privateKey).signTypedData(domainOf(chain.deployment, contract), typesFor(primaryType), message);
};

/**
 * Signs the creation of secret `fields.label` by the key's address, its
 * owner, and returns the body to submit. The nonce is keyed by the id the
 * secret will have, and read right before the signature.
 */
export const signAddSecret = async (
	chain: RecoveryChain,
	privateKey: string,
	fields: Omit<TypedMessages['AddSecret'], 'nonce' | 'deadline'>,
): Promise<{ id: string; body: Bodies['addSecret'] }> => {
	const signer = new Wallet(privateKey).address;
	const id = secretIdOf(signer, fields.label);
	// The domain check of a first signature goes out with the nonce read.
	const [nonce] = await Promise.all([chain.nonce(signer, id), checkDomain(chain, 'secretRecovery')]);
	const deadline = newDeadline();
	const signature = await signTyped(chain, privateKey, 'AddSecret', { ...fields, nonce, deadline });
	return { id, body: { ...fields, signer, deadline, signature } };
};

/** The payloads about an existing secret: each carries `version` and `round`, which the contract hashes from storage. */
export type BoundType = { [K in Signable]: 'version' extends keyof TypedMessages[K] ? K : never }[Signable];
type BoundFields<P extends BoundType> = Omit<TypedMessages[P], 'id' | 'version' | 'round' | 'nonce' | 'deadline'>;
type BodyOf<P extends Signable> = Bodies[Uncapitalize<P> & keyof Bodies];

/**
 * Signs a payload about secret `id` by the key's address, and returns the
 * body to submit. The secret and the signer's nonce for it are read together,
 * right before the signature, since the contract checks both against storage
 * at execution. For InitiateRecovery `round` is the stored one, before the
 * initiation increments it.
 */
export const signBound = async <P extends BoundType>(
	chain: RecoveryChain,
	privateKey: string,
	primaryType: P,
	id: string,
	fields: BoundFields<P>,
): Promise<{ body: BodyOf<P>; secret: SecretState }> => {
	const signer = new Wallet(privateKey).address;
	const [secret, nonce] = await Promise.all([chain.readSecret(id), chain.nonce(signer, id), checkDomain(chain, 'secretRecovery')]);
	if (!secret) throw new Error(`no secret ${id} on chain ${chain.deployment.chainId}`);
	const deadline = newDeadline();
	const message = { ...fields, id, version: secret.version, round: secret.recoveryRound, nonce, deadline } as TypedMessages[P];
	const signature = await signTyped<BoundType>(chain, privateKey, primaryType, message);
	return { body: { ...fields, id, signer, deadline, signature } as BodyOf<P>, secret };
};
