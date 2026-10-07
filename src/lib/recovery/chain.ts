// Reads of the recovery contracts (backitup-smart-contracts v2), for the
// screens of Phase 7: a secret's state, its guardians and slots at a version,
// a round's state and events, and the keyed nonces a signature needs.
//
// "The secret is not on chain" and "the chain did not answer" are different
// answers, and a caller acting on the first must never get it from the second
// (audit N-C1): an RPC failure is a ChainUnavailableError, never a null.
import { Contract, JsonRpcProvider, isError, zeroPadValue, type Log, type LogDescription } from 'ethers';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { nonceKey, registryNonceKey } from 'backitup-secret-recovery-sdk/lib/contract/nonceKey';
import type { Deployment } from './deployments';

export { RoundState };

const RECOVERY_ABI = [
	'function secretExists(bytes32 id) view returns (bool)',
	'function getSecret(bytes32 id) view returns (address owner, bool revoked, string label, uint256 threshold, uint256 recoveryDelay, uint256 recoveryWindow, uint256 recoveryRound, bool recoveryActive, address recoveryRecipient, uint256 executeAfter, uint256 version)',
	'function roundState(bytes32 id) view returns (uint8)',
	'function getGuardiansAt(bytes32 id, uint256 version) view returns (address[])',
	'function getShareAt(bytes32 id, uint256 version, address stealthAddress) view returns (bytes ephemeralPubKey, bytes shareEncrypted, bytes32 shareHash)',
	'function hasApproved(bytes32 id, address candidate, address guardian) view returns (bool)',
	'function canDecrypt(address account, bytes32 id) view returns (bool)',
	'function nonces(address owner, uint192 key) view returns (uint256)',
	'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
	'event RecoveryInitiated(bytes32 indexed id, uint256 indexed round, address initiator)',
	'event RecoveryQuorumReached(bytes32 indexed id, address indexed recipient, uint256 round, uint256 executeAfter, uint256 expiresAt)',
	'event RecoveryCancelled(bytes32 indexed id, uint256 round)',
	'event RecoveryExpired(bytes32 indexed id, uint256 round)',
];

const REGISTRY_ABI = [
	'function nonces(address owner, uint192 key) view returns (uint256)',
	'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
];

/** The chain did not answer; nothing is known about the question asked. */
export class ChainUnavailableError extends Error {}

export interface SecretState {
	owner: string;
	revoked: boolean;
	label: string;
	/** Guardian approvals needed for quorum — not the Shamir threshold. */
	threshold: bigint;
	recoveryDelay: bigint;
	recoveryWindow: bigint;
	recoveryRound: bigint;
	recoveryActive: boolean;
	recoveryRecipient: string;
	executeAfter: bigint;
	version: bigint;
}

export type RoundEvent =
	| { type: 'initiated'; round: bigint; initiator: string; block: number }
	| { type: 'quorum'; round: bigint; recipient: string; executeAfter: bigint; expiresAt: bigint; block: number }
	| { type: 'cancelled'; round: bigint; block: number }
	| { type: 'expired'; round: bigint; block: number };

export interface Eip712Domain {
	name: string;
	version: string;
	chainId: bigint;
	verifyingContract: string;
}

/** Public RPCs refuse wide log ranges; queries go in steps of this many blocks. */
const LOG_STEP = 10_000;

/**
 * A contract-level answer (a revert) passes through as it is: it says
 * something about the secret. Anything else — a timeout, a refused
 * connection, a malformed response — says nothing, and becomes a
 * ChainUnavailableError.
 */
const answered = async <T>(read: () => Promise<T>): Promise<T> => {
	try {
		return await read();
	} catch (e) {
		if (isError(e, 'CALL_EXCEPTION')) throw e;
		throw new ChainUnavailableError(`the chain did not answer: ${(e as Error).message}`);
	}
};

export class RecoveryChain {
	readonly provider: JsonRpcProvider;
	private readonly recovery: Contract;
	private readonly registry: Contract;

	constructor(readonly deployment: Deployment) {
		this.provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, { staticNetwork: true });
		this.recovery = new Contract(deployment.secretRecovery, RECOVERY_ABI, this.provider);
		this.registry = new Contract(deployment.keyRegistry, REGISTRY_ABI, this.provider);
	}

	/** The secret's state, or null when no secret has that id — never null for a chain that did not answer. */
	async readSecret(id: string): Promise<SecretState | null> {
		if (!(await answered(() => this.recovery.secretExists(id)))) return null;
		const r = await answered(() => this.recovery.getSecret(id));
		return {
			owner: r[0],
			revoked: r[1],
			label: r[2],
			threshold: r[3],
			recoveryDelay: r[4],
			recoveryWindow: r[5],
			recoveryRound: r[6],
			recoveryActive: r[7],
			recoveryRecipient: r[8],
			executeAfter: r[9],
			version: r[10],
		};
	}

	async roundState(id: string): Promise<RoundState> {
		return Number(await answered(() => this.recovery.roundState(id))) as RoundState;
	}

	/** The guardians' stealth addresses at `version`, in the contract's order. */
	async guardiansAt(id: string, version: bigint): Promise<string[]> {
		return [...(await answered(() => this.recovery.getGuardiansAt(id, version)))];
	}

	/** One guardian slot at `version`: the ephemeral key its stealth address derives from, and what it carries. */
	async shareAt(id: string, version: bigint, stealthAddress: string): Promise<{ ephemeralPubKey: string; shareEncrypted: string }> {
		const r = await answered(() => this.recovery.getShareAt(id, version, stealthAddress));
		return { ephemeralPubKey: r[0], shareEncrypted: r[1] };
	}

	async hasApproved(id: string, candidate: string, guardian: string): Promise<boolean> {
		return answered(() => this.recovery.hasApproved(id, candidate, guardian));
	}

	async canDecrypt(account: string, id: string): Promise<boolean> {
		return answered(() => this.recovery.canDecrypt(account, id));
	}

	/** The keyed nonce `signer` signs its next payload about secret `id` with. */
	async nonce(signer: string, id: string): Promise<bigint> {
		return answered(() => this.recovery.nonces(signer, nonceKey(id as `0x${string}`)));
	}

	/** The keyed nonce `registrant` signs its next registration for `scheme` with. */
	async registryNonce(registrant: string, scheme: number): Promise<bigint> {
		return answered(() => this.registry.nonces(registrant, registryNonceKey(scheme)));
	}

	/** The EIP-712 domain the contract signs under, read rather than assumed. */
	async eip712Domain(contract: 'secretRecovery' | 'keyRegistry'): Promise<Eip712Domain> {
		const target = contract === 'secretRecovery' ? this.recovery : this.registry;
		const r = await answered(() => target.eip712Domain());
		return { name: r[1], version: r[2], chainId: r[3], verifyingContract: r[4] };
	}

	/**
	 * The round events of secret `id`, oldest first, from `fromBlock` (the
	 * deployment's start by default) to the latest block, read in steps a
	 * public RPC accepts.
	 */
	async roundEvents(id: string, fromBlock = this.deployment.startBlock): Promise<RoundEvent[]> {
		const latest = await answered(() => this.provider.getBlockNumber());
		// One query per step: any of the four events, about this id.
		const topics = [ROUND_EVENTS.map((name) => this.recovery.interface.getEvent(name)!.topicHash), zeroPadValue(id, 32)];
		const out: RoundEvent[] = [];
		for (let from = fromBlock; from <= latest; from += LOG_STEP) {
			const to = Math.min(from + LOG_STEP - 1, latest);
			const logs = await answered(() => this.provider.getLogs({ address: this.deployment.secretRecovery, topics, fromBlock: from, toBlock: to }));
			for (const log of logs.sort(byPosition)) out.push(toRoundEvent(this.recovery.interface.parseLog(log)!, log.blockNumber));
		}
		return out;
	}
}

const ROUND_EVENTS = ['RecoveryInitiated', 'RecoveryQuorumReached', 'RecoveryCancelled', 'RecoveryExpired'];

const byPosition = (a: Log, b: Log): number => a.blockNumber - b.blockNumber || a.index - b.index;

const toRoundEvent = ({ name, args: a }: LogDescription, block: number): RoundEvent => {
	switch (name) {
		case 'RecoveryInitiated':
			return { type: 'initiated', round: a.round, initiator: a.initiator, block };
		case 'RecoveryQuorumReached':
			return { type: 'quorum', round: a.round, recipient: a.recipient, executeAfter: a.executeAfter, expiresAt: a.expiresAt, block };
		case 'RecoveryCancelled':
			return { type: 'cancelled', round: a.round, block };
		default:
			return { type: 'expired', round: a.round, block };
	}
};
