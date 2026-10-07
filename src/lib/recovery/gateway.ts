// Where a signed payload goes: to a relayer, which pays the gas, or straight
// to the contract's own *WithSig entry point from a wallet that pays its own.
// The signatures are the same either way; only who submits differs. Without
// the second path a relayer outage would stop every recovery action, the
// owner's veto included (chat repo: pq_recovery_services § Relayer).
import { Wallet } from 'ethers';
import type { ShareInput } from 'backitup-secret-recovery-sdk/lib/types';
import type { RecoveryChain } from './chain';
import type { RecoveryContract } from './deployments';

export type { ShareInput };

interface Signed {
	signer: string;
	/** Unix seconds. */
	deadline: bigint;
	signature: string;
}

interface AboutSecret extends Signed {
	id: string;
}

export interface Approval extends Signed {
	candidate: string;
}

/** What each entry point takes: the values that were signed, and the signature. typedData.ts's sign helpers return them. */
export interface Bodies {
	addSecret: Signed & { label: string; shares: ShareInput[]; threshold: bigint; recoveryDelay: bigint; recoveryWindow: bigint };
	reshare: AboutSecret & { shares: ShareInput[]; threshold: bigint };
	setRecoveryPolicy: AboutSecret & { recoveryDelay: bigint; recoveryWindow: bigint };
	initiateRecovery: AboutSecret;
	approveRecovery: AboutSecret & { candidate: string };
	approveRecoveryBatch: { id: string; approvals: Approval[] };
	cancelRecovery: AboutSecret;
	revokeSecret: AboutSecret;
	/** Burns `signer`'s nonce under `key` on `contract`, retiring every signature issued against it. */
	invalidateNonce: Signed & { contract: RecoveryContract; key: bigint };
	registerKeys: { registrant: string; scheme: bigint; stealthMetaAddress: string; deadline: bigint; signature: string };
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

const gatewayOf = (send: (name: keyof Bodies, body: unknown) => Promise<Dispatch>): Gateway =>
	Object.fromEntries((Object.keys(ROUTES) as (keyof Bodies)[]).map((name) => [name, (body: unknown) => send(name, body)])) as Gateway;

// The relayer's DTOs (backitup-recovery-backend) take uints as decimal
// strings, and a threshold — at most 32 — as a number.
const relayerJson = (key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? (key === 'threshold' ? Number(value) : value.toString()) : value;

// A half-open connection never settles on its own, and the button the person
// pressed would hang with it.
const RELAYER_TIMEOUT_MS = 30_000;

/** A relayer at `baseUrl` (its routes are `<base>/api/relayer/<route>`). */
export const relayerGateway = (baseUrl: string, fetchImpl: typeof fetch = fetch): Gateway => {
	const base = baseUrl.replace(/\/+$/, '');
	return gatewayOf(async (name, body) => {
		const route = ROUTES[name];
		const res = await fetchImpl(`${base}/api/relayer/${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body, relayerJson),
			signal: AbortSignal.timeout(RELAYER_TIMEOUT_MS),
		});
		if (!res.ok) throw new RelayerError(route, res.status, await res.text());
		return (await res.json()) as Dispatch;
	});
};

export interface DirectCall {
	contract: RecoveryContract;
	fn: string;
	args: unknown[];
}

const onRecovery = (fn: string, ...args: unknown[]): DirectCall => ({ contract: 'secretRecovery', fn, args });

/** The contract call each body becomes. */
const CALLS: { [K in keyof Bodies]: (b: Bodies[K]) => DirectCall } = {
	addSecret: (b) => onRecovery('addSecretWithSig', b.label, b.shares, b.threshold, b.recoveryDelay, b.recoveryWindow, b.signer, b.deadline, b.signature),
	reshare: (b) => onRecovery('reshareWithSig', b.id, b.shares, b.threshold, b.signer, b.deadline, b.signature),
	setRecoveryPolicy: (b) => onRecovery('setRecoveryPolicyWithSig', b.id, b.recoveryDelay, b.recoveryWindow, b.signer, b.deadline, b.signature),
	initiateRecovery: (b) => onRecovery('initiateRecoveryWithSig', b.id, b.signer, b.deadline, b.signature),
	approveRecovery: (b) => onRecovery('approveRecoveryWithSig', b.id, b.candidate, b.signer, b.deadline, b.signature),
	approveRecoveryBatch: (b) => onRecovery('approveRecoveryBatchWithSig', b.id, b.approvals),
	cancelRecovery: (b) => onRecovery('cancelRecoveryWithSig', b.id, b.signer, b.deadline, b.signature),
	revokeSecret: (b) => onRecovery('revokeSecretWithSig', b.id, b.signer, b.deadline, b.signature),
	invalidateNonce: (b) => ({ contract: b.contract, fn: 'invalidateNonceWithSig', args: [b.signer, b.key, b.deadline, b.signature] }),
	registerKeys: (b) => ({ contract: 'keyRegistry', fn: 'registerKeysOnBehalf', args: [b.registrant, b.scheme, b.stealthMetaAddress, b.deadline, b.signature] }),
};

export const directCall = <K extends keyof Bodies>(name: K, body: Bodies[K]): DirectCall => CALLS[name](body);

/**
 * Straight to the contracts from `payerPrivateKey`, which pays the gas. Each
 * call is simulated first, as a relayer's preflight is — a revert costs
 * nothing and comes back by name — and the receipt is awaited, so a revert
 * on chain is reported as one rather than as a later timeout.
 */
export const directGateway = (chain: RecoveryChain, payerPrivateKey: string): Gateway => {
	const payer = new Wallet(payerPrivateKey, chain.provider);
	return gatewayOf(async (name, body) => {
		const { contract, fn, args } = directCall(name, body as never);
		const method = chain.contracts[contract].connect(payer).getFunction(fn);
		await method.staticCall(...args);
		const tx = await method(...args);
		const receipt = await tx.wait();
		if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} reverted on chain`);
		return { txHash: tx.hash, status: 'MINED' };
	});
};
