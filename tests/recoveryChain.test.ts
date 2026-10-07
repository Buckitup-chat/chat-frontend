// The recovery chain layer: deployments, ids, EIP-712 signing and the two
// gateways. The typed data is checked against a second implementation — viem
// hashing the SDK's whole table — so a type ethers would hash differently, or a
// struct left out of a primary type's subset, fails here first.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { Interface, TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';
import { hashTypedData } from 'viem';
import { TYPES } from 'backitup-secret-recovery-sdk/lib/contract/typedData';
import { computeId } from 'backitup-secret-recovery-sdk/lib/contract/id';
import type { Hex } from 'backitup-secret-recovery-sdk/lib/types';
import { DEPLOYMENTS, recoveryDeployment, secretIdOf, secretRefOf } from '@/lib/recovery/deployments';
import { ABI, ChainUnavailableError, RecoveryChain, type Eip712Domain } from '@/lib/recovery/chain';
import { domainOf, signTyped, typesFor, type Signable } from '@/lib/recovery/typedData';
import { RelayerError, approvalBatch, directCall, relayerGateway, type Bodies } from '@/lib/recovery/gateway';

// viem v1's generics resolve this table to never; the check needs none of them.
const viemHash = hashTypedData as unknown as (args: Record<string, unknown>) => string;
const sepolia = DEPLOYMENTS[11155111];
const id = '0x' + '9f'.repeat(32);
const addr = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Hex;

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
	// A chain client whose contract reports `domain`; only what signing reads.
	const fakeChain = (domain: Partial<Eip712Domain>) =>
		({
			deployment: sepolia,
			eip712Domain: vi.fn(async () => ({ name: 'BackitupSecretRecovery', version: '2', chainId: 11155111n, ...domain })),
		}) as never as RecoveryChain;

	it('signs under the deployment\'s domain, recoverable to the signer', async () => {
		const wallet = Wallet.createRandom();
		const sig = await signTyped(fakeChain({}), wallet.privateKey, 'CancelRecovery', messages.CancelRecovery as never);
		expect(verifyTypedData(domainOf(sepolia, 'secretRecovery'), typesFor('CancelRecovery'), messages.CancelRecovery, sig)).toBe(wallet.address);
	});

	it('refuses to sign when the contract signs under another version or chain', async () => {
		const key = Wallet.createRandom().privateKey;
		await expect(signTyped(fakeChain({ version: '1' }), key, 'CancelRecovery', messages.CancelRecovery as never)).rejects.toThrow(/signs as BackitupSecretRecovery v1 on chain 11155111/);
		await expect(signTyped(fakeChain({ chainId: 10n }), key, 'CancelRecovery', messages.CancelRecovery as never)).rejects.toThrow(/v2 on chain 10;/);
	});

	it('signs a nonce burn under the domain of the contract it names', async () => {
		const wallet = Wallet.createRandom();
		const chain = fakeChain({ name: 'BackitupKeyRegistry', version: '1' });
		const sig = await signTyped(chain, wallet.privateKey, 'InvalidateNonce', messages.InvalidateNonce as never, 'keyRegistry');
		expect(verifyTypedData(domainOf(sepolia, 'keyRegistry'), typesFor('InvalidateNonce'), messages.InvalidateNonce, sig)).toBe(wallet.address);
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

/**
 * A JSON-RPC endpoint on localhost answering `eth_call` with `answer` — a
 * result, or an error as a node sends one — and counting the calls. Batches
 * are answered as nodes do, one response per request.
 */
const stubRpc = async (answer: () => { result?: string; error?: { code: number; message: string; data?: string } }) => {
	const calls: string[] = [];
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const body = JSON.parse(raw);
			const one = (r: { id: number; method: string }) => {
				calls.push(r.method);
				return { jsonrpc: '2.0', id: r.id, ...(r.method === 'eth_call' ? answer() : { result: '0x1' }) };
			};
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
		});
	});
	await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
};

describe('the chain', () => {
	// "Not on chain" and "no answer" are different (audit N-C1): a caller acting on the first must not get it from the second.
	it('says the chain did not answer, never that the secret is absent, when the RPC is down', async () => {
		const chain = new RecoveryChain({ ...sepolia, rpcUrl: 'http://127.0.0.1:9' });
		await expect(chain.readSecret(id)).rejects.toBeInstanceOf(ChainUnavailableError);
	});

	it('takes a JSON-RPC error on a call, which ethers reports as a call exception, for no answer', async () => {
		const rpc = await stubRpc(() => ({ error: { code: -32005, message: 'rate limit exceeded' } }));
		try {
			await expect(new RecoveryChain({ ...sepolia, rpcUrl: rpc.url }).readSecret(id)).rejects.toBeInstanceOf(ChainUnavailableError);
		} finally {
			rpc.close();
		}
	});

	it('reads the contract\'s SecretDoesNotExist as no such secret, and another revert as itself', async () => {
		let data = '0x9a117e98'; // SecretDoesNotExist()
		const rpc = await stubRpc(() => ({ error: { code: 3, message: 'execution reverted', data } }));
		try {
			const chain = new RecoveryChain({ ...sepolia, rpcUrl: rpc.url });
			expect(await chain.readSecret(id)).toBeNull();
			data = new Interface(ABI.secretRecovery).encodeErrorResult('NotGuardian', []);
			await expect(chain.readSecret(id)).rejects.toMatchObject({ code: 'CALL_EXCEPTION', revert: { name: 'NotGuardian' } });
		} finally {
			rpc.close();
		}
	});

	it('refuses a malformed id or address before asking the chain', async () => {
		// Ids arrive in peers' messages; a bad one is the message's fault, not the network's.
		const rpc = await stubRpc(() => ({ result: '0x' }));
		try {
			const chain = new RecoveryChain({ ...sepolia, rpcUrl: rpc.url });
			await expect(chain.readSecret('0x1234')).rejects.toThrow(TypeError);
			await expect(chain.nonce(addr(1), '0x' + '11'.repeat(40))).rejects.toThrow(TypeError);
			await expect(chain.nonce('0xnot-an-address', id)).rejects.toThrow(TypeError);
			expect(rpc.calls).toEqual([]);
		} finally {
			rpc.close();
		}
	});
});

const sig = '0x' + '00'.repeat(65);
const signed = { signer: addr(5), deadline: 1_800_000_000n, signature: sig };
const share = { stealthAddress: addr(1), ephemeralPubKey: ('0x02' + '11'.repeat(32)) as Hex, shareEncrypted: '0x01' as Hex };

describe('the relayer gateway', () => {
	const body: Bodies['addSecret'] = { ...signed, label: 'l', shares: [share, share], threshold: 2n, recoveryDelay: 0n, recoveryWindow: 604_800n };
	// As the relayer answers: 201 with its dispatch record.
	const relayer = (record: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({ _id: 'r1', chainId: 11155111, ...record }), { status: 201 }));

	it('posts the body to <base>/api/relayer/<route>, as the relayer\'s DTOs take it', async () => {
		const fetchImpl = relayer({ txHash: '0x' + 'ab'.repeat(32), status: 'PROCESSING' });
		const out = await relayerGateway('https://relay.example/recovery/', fetchImpl as never).addSecret(body);
		expect(out).toEqual({ txHash: '0x' + 'ab'.repeat(32), status: 'PROCESSING' });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
		expect(url).toBe('https://relay.example/recovery/api/relayer/add-secret');
		expect(JSON.parse(init.body)).toEqual({
			...body, threshold: 2, recoveryDelay: '0', recoveryWindow: '604800', deadline: '1800000000',
		});
	});

	it('reports a refusal with the relayer\'s status and words', async () => {
		const fetchImpl = vi.fn(async () => new Response('{"message":"InvalidSignature"}', { status: 400 }));
		await expect(relayerGateway('https://relay.example', fetchImpl as never).cancelRecovery({ ...signed, id })).rejects.toMatchObject({
			constructor: RelayerError, status: 400, route: 'cancel-recovery',
		});
	});

	it('reports a payload whose earlier send failed, which the relayer answers with that send\'s record', async () => {
		const fetchImpl = relayer({ txHash: '0x' + 'cd'.repeat(32), status: 'ERROR', errorMsg: 'Dropped from the mempool before it was mined' });
		await expect(relayerGateway('https://relay.example', fetchImpl as never).cancelRecovery({ ...signed, id })).rejects.toMatchObject({
			constructor: RelayerError, body: 'Dropped from the mempool before it was mined',
		});
	});
});

describe('an approval batch', () => {
	const approval = (n: number, about = id): Bodies['approveRecovery'] => ({ ...signed, signer: addr(n), id: about, candidate: addr(9) });

	it('keeps each approval\'s own four fields, the only ones the relayer takes', () => {
		expect(approvalBatch([approval(1), approval(2)])).toEqual({
			id,
			approvals: [1, 2].map((n) => ({ candidate: addr(9), signer: addr(n), deadline: signed.deadline, signature: sig })),
		});
	});

	it('is of one secret', () => {
		expect(() => approvalBatch([approval(1), approval(2, '0x' + '01'.repeat(32))])).toThrow(/same secret/);
		expect(() => approvalBatch([])).toThrow(/same secret/);
	});
});

describe('the direct gateway', () => {
	// The selectors of the deployed contracts (backitup-smart-contracts v2 ABIs):
	// a fragment in ABI that drifts from the contract changes its selector.
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
	const bodies: Bodies = {
		addSecret: { ...signed, label: 'l', shares: [share, share], threshold: 2n, recoveryDelay: 0n, recoveryWindow: 0n },
		reshare: { ...signed, id, shares: [share, share], threshold: 2n },
		setRecoveryPolicy: { ...signed, id, recoveryDelay: 86_400n, recoveryWindow: 604_800n },
		initiateRecovery: { ...signed, id },
		approveRecovery: { ...signed, id, candidate: addr(9) },
		approveRecoveryBatch: { id, approvals: [{ ...signed, candidate: addr(9) }] },
		cancelRecovery: { ...signed, id },
		revokeSecret: { ...signed, id },
		invalidateNonce: { ...signed, contract: 'keyRegistry', key: 1n },
		registerKeys: { registrant: addr(3), scheme: 1n, stealthMetaAddress: '0x02' + '33'.repeat(65), deadline: 1_800_000_000n, signature: sig },
	};

	for (const name of Object.keys(bodies) as (keyof Bodies)[]) {
		it(`${name}: becomes a call to the contract's own entry point`, () => {
			const { contract, fn, args } = directCall(name, bodies[name] as never);
			const data = new Interface(ABI[contract]).encodeFunctionData(fn, args);
			expect(data.slice(0, 10)).toBe(SELECTORS[fn]);
		});
	}

	it('submits a nonce burn to the contract the body names', () => {
		expect(directCall('invalidateNonce', { ...signed, contract: 'secretRecovery', key: 1n }).contract).toBe('secretRecovery');
		expect(directCall('invalidateNonce', { ...signed, contract: 'keyRegistry', key: 1n }).contract).toBe('keyRegistry');
	});
});
