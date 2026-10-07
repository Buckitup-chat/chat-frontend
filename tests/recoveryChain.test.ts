// The recovery chain layer: deployments, ids, EIP-712 signing and the two
// gateways. The typed data is checked against a second implementation — viem
// hashing the SDK's whole table — so a type ethers would hash differently, or a
// struct left out of a primary type's subset, fails here first.
import { describe, it, expect, vi } from 'vitest';
import { Interface, TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';
import { hashTypedData } from 'viem';
import { TYPES } from 'backitup-secret-recovery-sdk/lib/contract/typedData';
import { computeId } from 'backitup-secret-recovery-sdk/lib/contract/id';
import { DEPLOYMENTS, recoveryDeployment, secretIdOf, secretRefOf } from '@/lib/recovery/deployments';
import { ChainUnavailableError, RecoveryChain } from '@/lib/recovery/chain';
import { domainOf, signTyped, typesFor, type Signable } from '@/lib/recovery/typedData';
import { RelayerError, WRITE_ABI, directCall, relayerGateway, type Bodies } from '@/lib/recovery/gateway';

// viem v1's generics resolve this table to never; the check needs none of them.
const viemHash = hashTypedData as unknown as (args: Record<string, unknown>) => string;
const sepolia = DEPLOYMENTS[11155111];
const id = '0x' + '9f'.repeat(32);
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');

const messages: { [P in Signable]: Record<string, unknown> } = {
	AddSecret: {
		label: 'account-backup',
		shares: [{ stealthAddress: addr(1), ephemeralPubKey: '0x02' + '11'.repeat(32), shareEncrypted: '0x01' + 'aa'.repeat(64) }],
		threshold: 2n, recoveryDelay: 0n, recoveryWindow: 0n, nonce: 7n, deadline: 1_800_000_000n,
	},
	Reshare: { id, version: 2n, round: 1n, shares: [{ stealthAddress: addr(2), ephemeralPubKey: '0x03' + '22'.repeat(32), shareEncrypted: '0x01' }], threshold: 2n, nonce: 1n, deadline: 1_800_000_000n },
	SetRecoveryPolicy: { id, version: 1n, round: 0n, recoveryDelay: 86_400n, recoveryWindow: 604_800n, nonce: 3n, deadline: 1_800_000_000n },
	InitiateRecovery: { id, version: 1n, round: 0n, nonce: 0n, deadline: 1_800_000_000n },
	ApproveRecovery: { id, version: 1n, round: 1n, candidate: addr(9), nonce: 0n, deadline: 1_800_000_000n },
	CancelRecovery: { id, version: 1n, round: 1n, nonce: 4n, deadline: 1_800_000_000n },
	RevokeSecret: { id, version: 1n, round: 1n, nonce: 5n, deadline: 1_800_000_000n },
	RegisterKeys: { registrant: addr(3), scheme: 1n, stealthMetaAddress: '0x02' + '33'.repeat(65), nonce: 0n, deadline: 1_800_000_000n },
	InvalidateNonce: { signer: addr(4), key: 12n, nonce: 2n, deadline: 1_800_000_000n },
};

describe('the typed data', () => {
	for (const p of Object.keys(messages) as Signable[]) {
		it(`${p}: ethers over the reached types hashes as viem over the SDK's whole table`, () => {
			const contract = p === 'RegisterKeys' ? 'keyRegistry' : 'secretRecovery';
			const domain = domainOf(sepolia, contract);
			const ours = TypedDataEncoder.hash(domain, typesFor(p), messages[p]);
			const viems = viemHash({ domain, types: TYPES, primaryType: p, message: messages[p] });
			expect(ours).toBe(viems);
		});
	}

	it('names the referenced Share struct, and nothing the primary type does not reach', () => {
		expect(Object.keys(typesFor('AddSecret')).sort()).toEqual(['AddSecret', 'Share']);
		expect(Object.keys(typesFor('CancelRecovery'))).toEqual(['CancelRecovery']);
	});
});

describe('signing', () => {
	const fakeChain = (domain: { name: string; version: string; chainId: bigint }) =>
		({ deployment: { ...sepolia, chainId: 11155111 + Math.floor(Math.random() * 1e6) }, eip712Domain: vi.fn(async () => domain) }) as never as RecoveryChain;

	it('signs under the deployment\'s domain, recoverable to the signer', async () => {
		const wallet = Wallet.createRandom();
		const chain = { deployment: sepolia, eip712Domain: async () => ({ name: 'BackitupSecretRecovery', version: '2', chainId: 11155111n, verifyingContract: sepolia.secretRecovery }) } as never as RecoveryChain;
		const sig = await signTyped(chain, wallet.privateKey, 'CancelRecovery', messages.CancelRecovery as never);
		expect(verifyTypedData(domainOf(sepolia, 'secretRecovery'), typesFor('CancelRecovery'), messages.CancelRecovery, sig)).toBe(wallet.address);
	});

	it('refuses to sign when the contract signs under another domain', async () => {
		const chain = fakeChain({ name: 'BackitupSecretRecovery', version: '1', chainId: 11155111n });
		await expect(signTyped(chain, Wallet.createRandom().privateKey, 'CancelRecovery', messages.CancelRecovery as never)).rejects.toThrow(/signs as BackitupSecretRecovery v1/);
	});
});

describe('the deployment', () => {
	it('is Sepolia by default, and another known chain or endpoint by env', () => {
		expect(recoveryDeployment({}).chainId).toBe(11155111);
		const op = recoveryDeployment({ VITE_RECOVERY_CHAIN_ID: '10', VITE_RECOVERY_RELAYER_URL: 'https://relay.example/recovery' });
		expect(op).toMatchObject({ chainId: 10, secretRecovery: DEPLOYMENTS[10].secretRecovery, relayerUrl: 'https://relay.example/recovery' });
		expect(() => recoveryDeployment({ VITE_RECOVERY_CHAIN_ID: '1' })).toThrow(/no recovery deployment/);
	});

	it('derives a secret\'s id as the contract and the SDK do, and names it canonically', () => {
		const owner = Wallet.createRandom().address;
		expect(secretIdOf(owner, 'account-backup')).toBe(computeId(owner as `0x${string}`, 'account-backup'));
		expect(secretRefOf(sepolia, id.toUpperCase().replace('0X', '0x'))).toBe(`eip155:11155111:${sepolia.secretRecovery.toLowerCase()}/${id}`);
	});
});

describe('the chain', () => {
	it('says the chain did not answer, never that the secret is absent, when the RPC is down', async () => {
		// "Not on chain" and "no answer" are different (audit N-C1): a caller acting on the first must not get it from the second.
		const chain = new RecoveryChain({ ...sepolia, rpcUrl: 'http://127.0.0.1:9' });
		await expect(chain.readSecret(id)).rejects.toBeInstanceOf(ChainUnavailableError);
	});
});

describe('the relayer gateway', () => {
	const body: Bodies['cancelRecovery'] = { id, signer: addr(5), deadline: '1800000000', signature: '0x' + '00'.repeat(65) };

	it('posts the body to <base>/api/relayer/<route>', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ txHash: '0xabc', status: 'PENDING' }), { status: 200 }));
		const out = await relayerGateway('https://relay.example/recovery/', fetchImpl as never).cancelRecovery(body);
		expect(out).toEqual({ txHash: '0xabc', status: 'PENDING' });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
		expect(url).toBe('https://relay.example/recovery/api/relayer/cancel-recovery');
		expect(JSON.parse(init.body)).toEqual(body);
	});

	it('reports a refusal with the relayer\'s status and words', async () => {
		const fetchImpl = vi.fn(async () => new Response('{"message":"InvalidSignature"}', { status: 400 }));
		await expect(relayerGateway('https://relay.example', fetchImpl as never).cancelRecovery(body)).rejects.toMatchObject({
			constructor: RelayerError, status: 400, route: 'cancel-recovery',
		});
	});
});

describe('the direct gateway', () => {
	// The selectors of the deployed contracts (backitup-smart-contracts v2 ABIs):
	// a fragment in WRITE_ABI that drifts from the contract changes its selector.
	const SELECTORS: Record<string, string> = {
		addSecretWithSig: '0x0a6b5a67',
		reshareWithSig: '0xd333fa47',
		setRecoveryPolicyWithSig: '0xd40fb433',
		initiateRecoveryWithSig: '0x9ab53f7f',
		approveRecoveryWithSig: '0x2c908d8b',
		approveRecoveryBatchWithSig: '0x831788ed',
		cancelRecoveryWithSig: '0x6af8fc34',
		revokeSecretWithSig: '0x764b725f',
		invalidateNonceWithSig: '0x577aa9a5',
		registerKeysOnBehalf: '0xbdc7b4d9',
	};
	const sig = '0x' + '00'.repeat(65);
	const signed = { signer: addr(5), deadline: '1800000000', signature: sig };
	const share = { stealthAddress: addr(1), ephemeralPubKey: '0x02' + '11'.repeat(32), shareEncrypted: '0x01' };
	const bodies: Bodies = {
		addSecret: { ...signed, label: 'l', shares: [share, share], threshold: 2, recoveryDelay: '0', recoveryWindow: '0' },
		reshare: { ...signed, id, shares: [share, share], threshold: 2 },
		setRecoveryPolicy: { ...signed, id, recoveryDelay: '86400', recoveryWindow: '604800' },
		initiateRecovery: { ...signed, id },
		approveRecovery: { ...signed, id, candidate: addr(9) },
		approveRecoveryBatch: { id, approvals: [{ ...signed, candidate: addr(9) }] },
		cancelRecovery: { ...signed, id },
		revokeSecret: { ...signed, id },
		invalidateNonce: { ...signed, contract: 'keyRegistry', key: '1' },
		registerKeys: { registrant: addr(3), scheme: '1', stealthMetaAddress: '0x02' + '33'.repeat(65), deadline: '1800000000', signature: sig },
	};

	for (const name of Object.keys(bodies) as (keyof Bodies)[]) {
		it(`${name}: becomes a call to the contract's own entry point`, () => {
			const { contract, fn, args } = directCall(name, bodies[name] as never);
			const data = new Interface(WRITE_ABI[contract]).encodeFunctionData(fn, args);
			expect(data.slice(0, 10)).toBe(SELECTORS[fn]);
		});
	}

	it('submits a nonce burn to the contract the body names', () => {
		expect(directCall('invalidateNonce', { ...signed, contract: 'secretRecovery', key: '1' }).contract).toBe('secretRecovery');
		expect(directCall('invalidateNonce', { ...signed, contract: 'keyRegistry', key: '1' }).contract).toBe('keyRegistry');
	});
});
