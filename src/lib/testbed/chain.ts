import { createPublicClient, defineChain, http } from 'viem';
import { NETWORK } from './config';

const abi = [
	{
		type: 'function',
		name: 'nonces',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'canDecrypt',
		stateMutability: 'view',
		inputs: [
			{ name: 'account', type: 'address' },
			{ name: 'id', type: 'bytes32' },
		],
		outputs: [{ type: 'bool' }],
	},
	{
		type: 'function',
		name: 'getSecret',
		stateMutability: 'view',
		inputs: [{ name: 'id', type: 'bytes32' }],
		outputs: [
			{ name: 'owner', type: 'address' },
			{ name: 'revoked', type: 'bool' },
			{ name: 'label', type: 'string' },
			{ name: 'threshold', type: 'uint256' },
			{ name: 'recoveryDelay', type: 'uint256' },
			{ name: 'recoveryRound', type: 'uint256' },
			{ name: 'recoveryActive', type: 'bool' },
			{ name: 'recoveryRecipient', type: 'address' },
			{ name: 'executeAfter', type: 'uint256' },
			{ name: 'version', type: 'uint256' },
		],
	},
	{
		type: 'function',
		name: 'getShare',
		stateMutability: 'view',
		inputs: [
			{ name: 'id', type: 'bytes32' },
			{ name: 'stealthAddress', type: 'address' },
		],
		outputs: [
			{ name: 'ephemeralPubKey', type: 'bytes' },
			{ name: 'shareEncrypted', type: 'bytes' },
			{ name: 'shareHash', type: 'bytes32' },
		],
	},
] as const;

const registryAbi = [
	{
		type: 'function',
		name: 'nonces',
		stateMutability: 'view',
		inputs: [{ name: 'owner', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'stealthMetaAddressOf',
		stateMutability: 'view',
		inputs: [
			{ name: 'registrant', type: 'address' },
			{ name: 'scheme', type: 'uint256' },
		],
		outputs: [{ type: 'bytes' }],
	},
] as const;

export const chain = defineChain({
	id: NETWORK.chainId,
	name: `chain-${NETWORK.chainId}`,
	nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: [NETWORK.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(NETWORK.rpcUrl) });

export interface SecretState {
	owner: `0x${string}`;
	revoked: boolean;
	label: string;
	threshold: bigint;
	recoveryDelay: bigint;
	recoveryRound: bigint;
	recoveryActive: boolean;
	recoveryRecipient: `0x${string}`;
	executeAfter: bigint;
	version: bigint;
}

export async function readNonce(owner: `0x${string}`): Promise<bigint> {
	return publicClient.readContract({
		address: NETWORK.secretRecovery,
		abi,
		functionName: 'nonces',
		args: [owner],
	});
}

export async function readRegistryNonce(owner: `0x${string}`): Promise<bigint> {
	return publicClient.readContract({
		address: NETWORK.keyRegistry,
		abi: registryAbi,
		functionName: 'nonces',
		args: [owner],
	});
}

export async function readCanDecrypt(account: `0x${string}`, id: `0x${string}`): Promise<boolean> {
	return publicClient.readContract({
		address: NETWORK.secretRecovery,
		abi,
		functionName: 'canDecrypt',
		args: [account, id],
	});
}

export async function readSecret(id: `0x${string}`): Promise<SecretState> {
	const r = await publicClient.readContract({
		address: NETWORK.secretRecovery,
		abi,
		functionName: 'getSecret',
		args: [id],
	});
	return {
		owner: r[0],
		revoked: r[1],
		label: r[2],
		threshold: r[3],
		recoveryDelay: r[4],
		recoveryRound: r[5],
		recoveryActive: r[6],
		recoveryRecipient: r[7],
		executeAfter: r[8],
		version: r[9],
	};
}

export async function readSecretOrNull(id: `0x${string}`): Promise<SecretState | null> {
	try {
		return await readSecret(id);
	} catch {
		return null;
	}
}

export async function readShare(
	id: `0x${string}`,
	stealthAddress: `0x${string}`,
): Promise<{ ephemeralPubKey: `0x${string}`; shareEncrypted: `0x${string}`; shareHash: `0x${string}` }> {
	const r = await publicClient.readContract({
		address: NETWORK.secretRecovery,
		abi,
		functionName: 'getShare',
		args: [id, stealthAddress],
	});
	return { ephemeralPubKey: r[0], shareEncrypted: r[1], shareHash: r[2] };
}

export async function readStealthMetaAddress(
	registrant: `0x${string}`,
	scheme = NETWORK.stealthScheme,
): Promise<`0x${string}`> {
	return publicClient.readContract({
		address: NETWORK.keyRegistry,
		abi: registryAbi,
		functionName: 'stealthMetaAddressOf',
		args: [registrant, BigInt(scheme)],
	});
}

export async function readBalance(address: `0x${string}`): Promise<string> {
	try {
		const bal = await publicClient.getBalance({ address });
		return (Number(bal) / 1e18).toFixed(4) + ' ETH';
	} catch {
		return '?';
	}
}
