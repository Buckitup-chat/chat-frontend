// Reads of the recovery contracts (backitup-smart-contracts v2), for the
// screens of Phase 7: a secret's state, its guardians and slots at a version,
// a round's state and events, and the keyed nonces a signature needs.
//
// "The secret is not on chain" and "the chain did not answer" are different
// answers, and a caller acting on the first must never get it from the second
// (audit N-C1): an RPC failure is a ChainUnavailableError, never a null.
import { Contract, JsonRpcProvider, isError, type EventLog, type Result } from 'ethers';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { nonceKey, registryNonceKey } from 'backitup-secret-recovery-sdk/lib/contract/nonceKey';
import type { Deployment, RecoveryContract } from './deployments';

export { RoundState };

const errors = (names: string[]) => names.map((name) => `error ${name}()`);

// What both contracts inherit from BackitupSigned, and the errors they share.
const SIGNED_ABI = [
	'function nonces(address owner, uint192 key) view returns (uint256)',
	'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
	'function invalidateNonceWithSig(address signer, uint192 key, uint256 deadline, bytes signature) returns (uint256 nonce)',
	'error InvalidAccountNonce(address account, uint256 currentNonce)',
	'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
	'error StringTooLong(string str)',
	...errors(['DeadlineTooFar', 'InvalidShortString', 'InvalidSignature', 'SignatureExpired', 'ZeroAddress']),
];

/** The contracts as this client uses them. Their errors are listed so that a revert comes back by name. */
export const ABI: Readonly<Record<RecoveryContract, readonly string[]>> = {
	secretRecovery: [
		...SIGNED_ABI,
		'function getSecret(bytes32 id) view returns (address owner, bool revoked, string label, uint256 threshold, uint256 recoveryDelay, uint256 recoveryWindow, uint256 recoveryRound, bool recoveryActive, address recoveryRecipient, uint256 executeAfter, uint256 version)',
		'function roundState(bytes32 id) view returns (uint8)',
		'function getGuardiansAt(bytes32 id, uint256 version) view returns (address[])',
		'function getShareAt(bytes32 id, uint256 version, address stealthAddress) view returns (bytes ephemeralPubKey, bytes shareEncrypted, bytes32 shareHash)',
		'function hasApproved(bytes32 id, address candidate, address guardian) view returns (bool)',
		'function canDecrypt(address account, bytes32 id) view returns (bool)',
		'function addSecretWithSig(string label, (address stealthAddress, bytes ephemeralPubKey, bytes shareEncrypted)[] shares, uint256 threshold, uint256 recoveryDelay, uint256 recoveryWindow, address signer, uint256 deadline, bytes signature) returns (bytes32 id)',
		'function reshareWithSig(bytes32 id, (address stealthAddress, bytes ephemeralPubKey, bytes shareEncrypted)[] shares, uint256 threshold, address signer, uint256 deadline, bytes signature)',
		'function setRecoveryPolicyWithSig(bytes32 id, uint256 recoveryDelay, uint256 recoveryWindow, address signer, uint256 deadline, bytes signature)',
		'function initiateRecoveryWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		'function approveRecoveryWithSig(bytes32 id, address candidate, address signer, uint256 deadline, bytes signature)',
		'function approveRecoveryBatchWithSig(bytes32 id, (address candidate, address signer, uint256 deadline, bytes signature)[] approvals)',
		'function cancelRecoveryWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		'function revokeSecretWithSig(bytes32 id, address signer, uint256 deadline, bytes signature)',
		'event RecoveryInitiated(bytes32 indexed id, uint256 indexed round, address initiator)',
		'event RecoveryQuorumReached(bytes32 indexed id, address indexed recipient, uint256 round, uint256 executeAfter, uint256 expiresAt)',
		'event RecoveryCancelled(bytes32 indexed id, uint256 round)',
		'event RecoveryExpired(bytes32 indexed id, uint256 round)',
		...errors([
			'AlreadyApproved', 'DuplicateGuardian', 'DuplicateSecret', 'EmptyLabel', 'InvalidDelay', 'InvalidThreshold',
			'InvalidWindow', 'NoActiveRecovery', 'NoGuardians', 'NotGuardian', 'NotOwner', 'PolicyUnchanged',
			'QuorumAlreadyReached', 'RecoveryAlreadyActive', 'RecoveryRoundExpired', 'SecretDoesNotExist',
			'SecretIsRevoked', 'TooManyGuardians', 'UseKeyedNonce',
		]),
	],
	keyRegistry: [
		...SIGNED_ABI,
		'function registerKeysOnBehalf(address registrant, uint256 scheme, bytes stealthMetaAddress, uint256 deadline, bytes signature)',
	],
};

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

const ROUND_EVENTS: Record<string, (a: Result, block: number) => RoundEvent> = {
	RecoveryInitiated: (a, block) => ({ type: 'initiated', round: a.round, initiator: a.initiator, block }),
	RecoveryQuorumReached: (a, block) => ({ type: 'quorum', round: a.round, recipient: a.recipient, executeAfter: a.executeAfter, expiresAt: a.expiresAt, block }),
	RecoveryCancelled: (a, block) => ({ type: 'cancelled', round: a.round, block }),
	RecoveryExpired: (a, block) => ({ type: 'expired', round: a.round, block }),
};

export interface Eip712Domain {
	name: string;
	version: string;
	chainId: bigint;
	verifyingContract: string;
}

/** Public RPCs refuse wide log ranges; queries go in steps of this many blocks. */
const LOG_STEP = 10_000;
/** Steps queried at once; ethers sends them to the RPC as one batch. */
const LOG_STEPS_AT_ONCE = 8;

/**
 * A contract-level answer (a revert) passes through as it is: it says
 * something about the secret. So does an argument the caller got wrong.
 * Anything else — a timeout, a refused connection, a malformed response —
 * says nothing, and becomes a ChainUnavailableError.
 */
const answered = async <T>(read: () => Promise<T>): Promise<T> => {
	try {
		return await read();
	} catch (e) {
		if (isError(e, 'CALL_EXCEPTION') || isError(e, 'INVALID_ARGUMENT')) throw e;
		throw new ChainUnavailableError(`the chain did not answer: ${(e as Error).message}`);
	}
};

export class RecoveryChain {
	readonly provider: JsonRpcProvider;
	readonly contracts: Readonly<Record<RecoveryContract, Contract>>;

	constructor(readonly deployment: Deployment) {
		// Polled while a receipt is awaited: an OP block takes 2 s, and ethers'
		// default of 4 s would notice each receipt a block or two late.
		this.provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, { staticNetwork: true, pollingInterval: 1000 });
		this.contracts = {
			secretRecovery: new Contract(deployment.secretRecovery, ABI.secretRecovery, this.provider),
			keyRegistry: new Contract(deployment.keyRegistry, ABI.keyRegistry, this.provider),
		};
	}

	private get recovery(): Contract {
		return this.contracts.secretRecovery;
	}

	/** The secret's state, or null when no secret has that id — never null for a chain that did not answer. */
	async readSecret(id: string): Promise<SecretState | null> {
		try {
			return (await answered(() => this.recovery.getSecret(id))).toObject() as SecretState;
		} catch (e) {
			if (isError(e, 'CALL_EXCEPTION') && e.revert?.name === 'SecretDoesNotExist') return null;
			throw e;
		}
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
		return { ephemeralPubKey: r.ephemeralPubKey, shareEncrypted: r.shareEncrypted };
	}

	async hasApproved(id: string, candidate: string, guardian: string): Promise<boolean> {
		return answered(() => this.recovery.hasApproved(id, candidate, guardian));
	}

	async canDecrypt(account: string, id: string): Promise<boolean> {
		return answered(() => this.recovery.canDecrypt(account, id));
	}

	/** The keyed nonce `signer` signs its next payload about secret `id` with. */
	async nonce(signer: string, id: string): Promise<bigint> {
		const key = nonceKey(id as `0x${string}`);
		return answered(() => this.recovery.nonces(signer, key));
	}

	/** The keyed nonce `registrant` signs its next registration for `scheme` with. */
	async registryNonce(registrant: string, scheme: number): Promise<bigint> {
		const key = registryNonceKey(scheme);
		return answered(() => this.contracts.keyRegistry.nonces(registrant, key));
	}

	/** The EIP-712 domain the contract signs under, read rather than assumed. */
	async eip712Domain(contract: RecoveryContract): Promise<Eip712Domain> {
		const r = await answered(() => this.contracts[contract].eip712Domain());
		return { name: r.name, version: r.version, chainId: r.chainId, verifyingContract: r.verifyingContract };
	}

	/**
	 * The round events of secret `id`, oldest first, from `fromBlock` (the
	 * deployment's start by default) to the latest block, read in steps a
	 * public RPC accepts.
	 */
	async roundEvents(id: string, fromBlock = this.deployment.startBlock): Promise<RoundEvent[]> {
		const latest = await answered(() => this.provider.getBlockNumber());
		// Any of the round events, about this id.
		const filter = [Object.keys(ROUND_EVENTS), id];
		const steps: number[] = [];
		for (let from = fromBlock; from <= latest; from += LOG_STEP) steps.push(from);
		const logs: EventLog[] = [];
		for (let i = 0; i < steps.length; i += LOG_STEPS_AT_ONCE) {
			const batch = await answered(() =>
				Promise.all(steps.slice(i, i + LOG_STEPS_AT_ONCE).map((from) => this.recovery.queryFilter(filter, from, Math.min(from + LOG_STEP - 1, latest)))),
			);
			logs.push(...(batch.flat() as EventLog[]));
		}
		return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index).map((log) => ROUND_EVENTS[log.eventName](log.args, log.blockNumber));
	}
}
