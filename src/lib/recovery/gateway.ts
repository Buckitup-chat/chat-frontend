// Where a signed payload goes: to a relayer, which pays the gas, or straight
// to the contract's own *WithSig entry point from a wallet that pays its own.
// The signatures are the same either way; only who submits differs. Without
// the second path a relayer outage would stop every recovery action, the
// owner's veto included (chat repo: pq_recovery_services § Relayer).
import { Contract, Wallet } from 'ethers';
import type { RecoveryChain } from './chain';

type WriteContract = 'secretRecovery' | 'keyRegistry';

export interface ShareInput {
	stealthAddress: string;
	ephemeralPubKey: string;
	shareEncrypted: string;
}

interface Signed {
	signer: string;
	/** Unix seconds, as a decimal string. */
	deadline: string;
	signature: string;
}

interface AboutSecret extends Signed {
	id: string;
}

export interface Approval extends Signed {
	candidate: string;
}

/** The relayer's request bodies (backitup-recovery-backend relayer DTOs): uints as decimal strings, thresholds as numbers. */
export interface Bodies {
	addSecret: Signed & { label: string; shares: ShareInput[]; threshold: number; recoveryDelay: string; recoveryWindow: string };
	reshare: AboutSecret & { shares: ShareInput[]; threshold: number };
	setRecoveryPolicy: AboutSecret & { recoveryDelay: string; recoveryWindow: string };
	initiateRecovery: AboutSecret;
	approveRecovery: AboutSecret & { candidate: string };
	approveRecoveryBatch: { id: string; approvals: Approval[] };
	cancelRecovery: AboutSecret;
	revokeSecret: AboutSecret;
	/** Burns `signer`'s nonce under `key` (decimal uint192) on `contract`, retiring every signature issued against it. */
	invalidateNonce: Signed & { contract: WriteContract; key: string };
	registerKeys: { registrant: string; scheme: string; stealthMetaAddress: string; deadline: string; signature: string };
}

export interface Dispatch {
	txHash: string;
	status: string;
}

export type Gateway = { [K in keyof Bodies]: (body: Bodies[K]) => Promise<Dispatch> };

/** A relayer refused or failed a payload; `status` and `body` are its answer. */
export class RelayerError extends Error {
	constructor(
		readonly route: string,
		readonly status: number,
		readonly body: string,
	) {
		super(`relayer ${route} failed (${status}): ${body}`);
	}
}

const ROUTES: { [K in keyof Bodies]: string } = {
	addSecret: 'add-secret',
	reshare: 'reshare',
	setRecoveryPolicy: 'set-recovery-policy',
	initiateRecovery: 'initiate-recovery',
	approveRecovery: 'approve-recovery',
	approveRecoveryBatch: 'approve-recovery-batch',
	cancelRecovery: 'cancel-recovery',
	revokeSecret: 'revoke-secret',
	invalidateNonce: 'invalidate-nonce',
	registerKeys: 'register-keys',
};

// A half-open connection never settles on its own, and the button the person
// pressed would hang with it.
const RELAYER_TIMEOUT_MS = 30_000;

/** A relayer at `baseUrl` (its routes are `<base>/api/relayer/<route>`). */
export const relayerGateway = (baseUrl: string, fetchImpl: typeof fetch = fetch): Gateway => {
	const base = baseUrl.replace(/\/+$/, '');
	const post = async (route: string, body: unknown): Promise<Dispatch> => {
		const res = await fetchImpl(`${base}/api/relayer/${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(RELAYER_TIMEOUT_MS),
		});
		if (!res.ok) throw new RelayerError(route, res.status, await res.text());
		return (await res.json()) as Dispatch;
	};
	return Object.fromEntries(
		(Object.keys(ROUTES) as (keyof Bodies)[]).map((name) => [name, (body: unknown) => post(ROUTES[name], body)]),
	) as Gateway;
};

// Both contracts inherit it from BackitupSigned.
const INVALIDATE_NONCE = 'function invalidateNonceWithSig(address signer, uint192 key, uint256 deadline, bytes signature) returns (uint256 nonce)';

/** The entry points a signed payload is submitted to, per contract. */
export const WRITE_ABI: Readonly<Record<WriteContract, readonly string[]>> = {
	secretRecovery: [
		'function addSecretWithSig(string label, (address stealthAddress, bytes ephemeralPubKey, bytes shareEncrypted)[] shares, uint256 threshold, uint256 recoveryDelay, uint256 recoveryWindow, address signer, uint256 deadline, bytes signature) returns (bytes32 id)',
		'function reshareWithSig(bytes32 id, (address stealthAddress, bytes ephemeralPubKey, bytes shareEncrypted)[] shares, uint256 threshold, address signer, uint256 deadline, bytes signature)',
		'function setRecoveryPolicyWithSig(bytes32 id, uint256 recoveryDelay, uint256 recoveryWindow, address signer, uint256 deadline, bytes signature)',
		'function initiateRecoveryWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		'function approveRecoveryWithSig(bytes32 id, address candidate, address signer, uint256 deadline, bytes signature)',
		'function approveRecoveryBatchWithSig(bytes32 id, (address candidate, address signer, uint256 deadline, bytes signature)[] approvals)',
		'function cancelRecoveryWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		'function revokeSecretWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		INVALIDATE_NONCE,
	],
	keyRegistry: [
		'function registerKeysOnBehalf(address registrant, uint256 scheme, bytes stealthMetaAddress, uint256 deadline, bytes signature)',
		INVALIDATE_NONCE,
	],
};

/** The contract call each body becomes: which contract, which function, which arguments. */
export const directCall = <K extends keyof Bodies>(name: K, b: Bodies[K]): { contract: WriteContract; fn: string; args: unknown[] } => {
	const signed = (s: Signed) => [s.signer, BigInt(s.deadline), s.signature];
	switch (name) {
		case 'addSecret': {
			const x = b as Bodies['addSecret'];
			return { contract: 'secretRecovery', fn: 'addSecretWithSig', args: [x.label, x.shares, BigInt(x.threshold), BigInt(x.recoveryDelay), BigInt(x.recoveryWindow), ...signed(x)] };
		}
		case 'reshare': {
			const x = b as Bodies['reshare'];
			return { contract: 'secretRecovery', fn: 'reshareWithSig', args: [x.id, x.shares, BigInt(x.threshold), ...signed(x)] };
		}
		case 'setRecoveryPolicy': {
			const x = b as Bodies['setRecoveryPolicy'];
			return { contract: 'secretRecovery', fn: 'setRecoveryPolicyWithSig', args: [x.id, BigInt(x.recoveryDelay), BigInt(x.recoveryWindow), ...signed(x)] };
		}
		case 'approveRecovery': {
			const x = b as Bodies['approveRecovery'];
			return { contract: 'secretRecovery', fn: 'approveRecoveryWithSig', args: [x.id, x.candidate, ...signed(x)] };
		}
		case 'approveRecoveryBatch': {
			const x = b as Bodies['approveRecoveryBatch'];
			const approvals = x.approvals.map((a) => ({ candidate: a.candidate, signer: a.signer, deadline: BigInt(a.deadline), signature: a.signature }));
			return { contract: 'secretRecovery', fn: 'approveRecoveryBatchWithSig', args: [x.id, approvals] };
		}
		case 'invalidateNonce': {
			const x = b as Bodies['invalidateNonce'];
			return { contract: x.contract, fn: 'invalidateNonceWithSig', args: [x.signer, BigInt(x.key), BigInt(x.deadline), x.signature] };
		}
		case 'registerKeys': {
			const x = b as Bodies['registerKeys'];
			return { contract: 'keyRegistry', fn: 'registerKeysOnBehalf', args: [x.registrant, BigInt(x.scheme), x.stealthMetaAddress, BigInt(x.deadline), x.signature] };
		}
		default: {
			// initiateRecovery, cancelRecovery, revokeSecret: the id and the signature.
			const x = b as AboutSecret;
			return { contract: 'secretRecovery', fn: `${name}WithSig`, args: [x.id, ...signed(x)] };
		}
	}
};

/**
 * Straight to the contracts from `payerPrivateKey`, which pays the gas. Each
 * call is simulated first, as a relayer's preflight is — a revert costs
 * nothing and comes back with its name — and the receipt is awaited, so a
 * revert on chain is reported as one rather than as a later timeout.
 */
export const directGateway = (chain: RecoveryChain, payerPrivateKey: string): Gateway => {
	const payer = new Wallet(payerPrivateKey, chain.provider);
	const contracts = {
		secretRecovery: new Contract(chain.deployment.secretRecovery, WRITE_ABI.secretRecovery, payer),
		keyRegistry: new Contract(chain.deployment.keyRegistry, WRITE_ABI.keyRegistry, payer),
	};
	const send = async (name: keyof Bodies, body: unknown): Promise<Dispatch> => {
		const { contract, fn, args } = directCall(name, body as never);
		const method = contracts[contract].getFunction(fn);
		await method.staticCall(...args);
		const tx = await method(...args);
		const receipt = await tx.wait();
		if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted on chain`);
		return { txHash: tx.hash, status: 'MINED' };
	};
	return Object.fromEntries((Object.keys(ROUTES) as (keyof Bodies)[]).map((name) => [name, (body: unknown) => send(name, body)])) as Gateway;
};
