import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK } from './config';

const domain = {
	name: 'BackitupSecretRecovery',
	version: '1',
	chainId: NETWORK.chainId,
	verifyingContract: NETWORK.secretRecovery,
} as const;

const registryDomain = {
	name: 'BackitupKeyRegistry',
	version: '1',
	chainId: NETWORK.chainId,
	verifyingContract: NETWORK.keyRegistry,
} as const;

const shareType = [
	{ name: 'stealthAddress', type: 'address' },
	{ name: 'ephemeralPubKey', type: 'bytes' },
	{ name: 'shareEncrypted', type: 'bytes' },
] as const;

export interface ShareInput {
	stealthAddress: `0x${string}`;
	ephemeralPubKey: `0x${string}`;
	shareEncrypted: `0x${string}`;
}

type PrivKey = `0x${string}`;

export async function signAddSecret(
	pk: PrivKey,
	params: {
		label: string;
		shares: ShareInput[];
		threshold: bigint;
		recoveryDelay: bigint;
		nonce: bigint;
		deadline: bigint;
	},
): Promise<`0x${string}`> {
	const account = privateKeyToAccount(pk);
	return account.signTypedData({
		domain,
		types: {
			Share: shareType,
			AddSecret: [
				{ name: 'label', type: 'string' },
				{ name: 'shares', type: 'Share[]' },
				{ name: 'threshold', type: 'uint256' },
				{ name: 'recoveryDelay', type: 'uint256' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		},
		primaryType: 'AddSecret',
		message: params,
	});
}

export async function signInitiateRecovery(
	pk: PrivKey,
	params: { id: `0x${string}`; nonce: bigint; deadline: bigint },
): Promise<`0x${string}`> {
	const account = privateKeyToAccount(pk);
	return account.signTypedData({
		domain,
		types: {
			InitiateRecovery: [
				{ name: 'id', type: 'bytes32' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		},
		primaryType: 'InitiateRecovery',
		message: params,
	});
}

export async function signApproveRecovery(
	pk: PrivKey,
	params: { id: `0x${string}`; round: bigint; candidate: `0x${string}`; nonce: bigint; deadline: bigint },
): Promise<`0x${string}`> {
	const account = privateKeyToAccount(pk);
	return account.signTypedData({
		domain,
		types: {
			ApproveRecovery: [
				{ name: 'id', type: 'bytes32' },
				{ name: 'round', type: 'uint256' },
				{ name: 'candidate', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		},
		primaryType: 'ApproveRecovery',
		message: params,
	});
}

export async function signRegisterKeys(
	pk: PrivKey,
	params: { registrant: `0x${string}`; scheme: bigint; stealthMetaAddress: `0x${string}`; nonce: bigint; deadline: bigint },
): Promise<`0x${string}`> {
	const account = privateKeyToAccount(pk);
	return account.signTypedData({
		domain: registryDomain,
		types: {
			RegisterKeys: [
				{ name: 'registrant', type: 'address' },
				{ name: 'scheme', type: 'uint256' },
				{ name: 'stealthMetaAddress', type: 'bytes' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		},
		primaryType: 'RegisterKeys',
		message: params,
	});
}

export async function signCancelRecovery(
	pk: PrivKey,
	params: { id: `0x${string}`; nonce: bigint; deadline: bigint },
): Promise<`0x${string}`> {
	const account = privateKeyToAccount(pk);
	return account.signTypedData({
		domain,
		types: {
			CancelRecovery: [
				{ name: 'id', type: 'bytes32' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		},
		primaryType: 'CancelRecovery',
		message: params,
	});
}
