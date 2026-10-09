// Where the recovery contracts live, and the services that front them
// (chat repo: pq_recovery_services). A deployment is a chain, its two
// contracts and the block they were deployed in — the indexer's start.
//
// The relayer is configuration, not a constant: the design assumes many
// relayers, and a client that pays its own gas needs none (gateway.ts).
import { AbiCoder, keccak256 } from 'ethers';

/** The two contracts of a deployment, named as its address fields are. */
export type RecoveryContract = 'secretRecovery' | 'keyRegistry';

export interface Deployment {
	chainId: number;
	rpcUrl: string;
	secretRecovery: string;
	keyRegistry: string;
	/** The block the contracts were deployed in; nothing of them is older. */
	startBlock: number;
	/** Seconds between blocks; receipts are polled at half of it. */
	blockTime: number;
	/** The relayer's base URL, or null where none is run for this deployment. */
	relayerUrl: string | null;
}

/** The deployments of contracts v2 (backitup-smart-contracts, `security/contracts-v2`). */
export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = {
	// Sepolia: the deployment the hosted relayer and nodes serve. Its RPC keeps
	// logs back to the start block, where round events are read from, and
	// answers batched requests; publicnode drops Sepolia logs older than about
	// 10k blocks. It refuses requests without a User-Agent, which a browser
	// always sends and ethers under node does not.
	11155111: {
		chainId: 11155111,
		rpcUrl: 'https://0xrpc.io/sep',
		secretRecovery: '0xd9FFD20F2DB9c774b9f0237c4837f52DCbD937a7',
		keyRegistry: '0xAD6bD551224003E621d0B4b640C33eF29a5e9828',
		startBlock: 11787426,
		blockTime: 12,
		relayerUrl: 'https://backitup-recovery-backend-production.up.railway.app',
	},
	// OP Mainnet: a test deployment; no relayer is hosted for it.
	10: {
		chainId: 10,
		rpcUrl: 'https://mainnet.optimism.io',
		secretRecovery: '0x45907bD5636CCECE1819fCd6433DEC71C78F3BB3',
		keyRegistry: '0x8364c4550CA2171A9bB2277B74C8B73ae2eBF21c',
		startBlock: 157813997,
		blockTime: 2,
		relayerUrl: null,
	},
};

const DEFAULT_CHAIN_ID = 11155111;

/**
 * The deployment this build talks to: Sepolia unless `VITE_RECOVERY_CHAIN_ID`
 * names another known one; `VITE_RECOVERY_RPC_URL` and
 * `VITE_RECOVERY_RELAYER_URL` replace its endpoints.
 */
export const recoveryDeployment = (env: Record<string, string | undefined> = import.meta.env): Deployment => {
	const chainId = env.VITE_RECOVERY_CHAIN_ID ? Number(env.VITE_RECOVERY_CHAIN_ID) : DEFAULT_CHAIN_ID;
	const known = DEPLOYMENTS[chainId];
	if (!known) throw new Error(`no recovery deployment is known on chain ${env.VITE_RECOVERY_CHAIN_ID}`);
	return {
		...known,
		rpcUrl: env.VITE_RECOVERY_RPC_URL || known.rpcUrl,
		relayerUrl: env.VITE_RECOVERY_RELAYER_URL || known.relayerUrl,
	};
};

/** `eip155:<chainId>:<contract>`, lowercase: the namespace part of a `secret_ref` (07 § recovery_share). */
export const deploymentNamespace = (d: Deployment): string => `eip155:${d.chainId}:${d.secretRecovery.toLowerCase()}`;

/** The contract's `computeId`: `keccak256(abi.encode(owner, label))`. */
export const secretIdOf = (owner: string, label: string): string =>
	keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'string'], [owner, label]));

/** `<namespace>/<id>`, canonical — lowercase hex, decimal chain id — as every recovery message names a secret. */
export const secretRefOf = (d: Deployment, id: string): string => `${deploymentNamespace(d)}/${id.toLowerCase()}`;
