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

/**
 * A submission that was accepted: PROCESSED once mined, PROCESSING while a
 * relayer is still sending it (the relayer's dispatch record). `txHash` is
 * absent while an identical request ahead of this one is being sent.
 */
export interface Dispatch {
	txHash?: string;
	status: 'PROCESSING' | 'PROCESSED';
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
		// A payload sent before answers with that send's record, a failed one included.
		const record = (await res.json()) as { txHash?: string; status: string; errorMsg?: string };
		if (record.status === 'ERROR') throw new RelayerError(route, res.status, record.errorMsg ?? 'dispatch failed');
		return { txHash: record.txHash, status: record.status as Dispatch['status'] };
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
 * One batch of guardian approvals for secret `id`, from the bodies each
 * guardian's signBound returned. Each approval keeps only its own four
 * fields: the relayer refuses any other.
 */
export const approvalBatch = (bodies: Bodies['approveRecovery'][]): Bodies['approveRecoveryBatch'] => {
	const id = bodies[0]?.id;
	if (!id || bodies.some((b) => b.id !== id)) throw new Error('an approval batch is one or more approvals of the same secret');
	return { id, approvals: bodies.map(({ candidate, signer, deadline, signature }) => ({ candidate, signer, deadline, signature })) };
};

// A mined or reverted transaction is reported long before this; one still
// pending after it was dropped or underpriced, and is not waited for further.
const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Straight to the contracts from `payerPrivateKey`, which pays the gas. Each
 * call is simulated first, as a relayer's preflight is — a revert costs
 * nothing and comes back by name — and the receipt is awaited, so a revert
 * on chain throws (CALL_EXCEPTION) rather than surfacing as a later timeout.
 * Calls go one at a time: concurrent sends from one wallet would take the
 * same nonce, and all but one would fail.
 */
export const directGateway = (chain: RecoveryChain, payerPrivateKey: string): Gateway => {
	const payer = new Wallet(payerPrivateKey, chain.provider);
	let queue: Promise<unknown> = Promise.resolve();
	const submit = async (name: keyof Bodies, body: unknown): Promise<Dispatch> => {
		const { contract, fn, args } = directCall(name, body as never);
		const method = chain.contracts[contract].connect(payer).getFunction(fn);
		await method.staticCall(...args);
		const tx = await method(...args);
		await tx.wait(1, RECEIPT_TIMEOUT_MS);
		return { txHash: tx.hash, status: 'PROCESSED' };
	};
	return gatewayOf((name, body) => {
		const sent = queue.then(() => submit(name, body));
		queue = sent.catch(() => undefined);
		return sent;
	});
};
