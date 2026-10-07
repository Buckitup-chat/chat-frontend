// Acceptance against a live deployment: a fresh owner creates a secret through
// each gateway — a relayer's, and the direct one, which pays its own gas — and
// the secret is read back from the chain. Gated behind RECOVERY_CHAIN=1 since
// it spends gas; CI never runs it:
//
//   RECOVERY_CHAIN=1 RECOVERY_CHAIN_ID=10 RECOVERY_RELAYER_URL=http://localhost:3011 \
//   RECOVERY_PAYER_KEY=0x… npx vitest run tests/recoveryChain.live.test.ts
//
// The relayer path needs a relayer for the deployment (none is hosted for OP
// Mainnet; run one locally), the direct path a funded RECOVERY_PAYER_KEY.
// Either is skipped when what it needs is not given.
import { describe, it, expect, vi } from 'vitest';
import { Wallet, hexlify, randomBytes } from 'ethers';
import type { Hex } from 'backitup-secret-recovery-sdk/lib/types';
import { recoveryDeployment } from '@/lib/recovery/deployments';
import { RecoveryChain, RoundState } from '@/lib/recovery/chain';
import { signAddSecret, signBound } from '@/lib/recovery/typedData';
import { directGateway, relayerGateway, type Gateway, type ShareInput } from '@/lib/recovery/gateway';

const env = process.env;
const live = env.RECOVERY_CHAIN === '1';
const deployment = live
	? recoveryDeployment({
			VITE_RECOVERY_CHAIN_ID: env.RECOVERY_CHAIN_ID,
			VITE_RECOVERY_RPC_URL: env.RECOVERY_RPC_URL,
			VITE_RECOVERY_RELAYER_URL: env.RECOVERY_RELAYER_URL,
		})
	: null;

// Two guardian slots of the shape a share set has: fresh stealth addresses,
// their ephemeral keys, and a delivery record (0x01 || split_root) each. The
// stealth keys are kept, so a guardian can sign.
const shareSet = () => {
	const guardians = [Wallet.createRandom(), Wallet.createRandom()];
	const shares: ShareInput[] = guardians.map((g) => ({
		stealthAddress: g.address as Hex,
		ephemeralPubKey: Wallet.createRandom().signingKey.compressedPublicKey as Hex,
		shareEncrypted: ('0x01' + hexlify(randomBytes(32)).slice(2)) as Hex,
	}));
	return { guardians, shares };
};

const createsSecret = async (chain: RecoveryChain, gateway: Gateway) => {
	const owner = Wallet.createRandom();
	const { guardians, shares } = shareSet();
	const label = `acceptance-${Date.now()}`;
	const fromBlock = await chain.provider.getBlockNumber();
	const { id, body } = await signAddSecret(chain, owner.privateKey, { label, shares, threshold: 2n, recoveryDelay: 0n, recoveryWindow: 0n });
	expect(await chain.readSecret(id)).toBeNull();
	const dispatch = await gateway.addSecret(body);
	expect(dispatch.txHash).toMatch(/^0x[0-9a-f]{64}$/i);

	// A relayer answers before the transaction is mined.
	const secret = await vi.waitUntil(() => chain.readSecret(id), { interval: 2000, timeout: 90_000 });
	expect(secret).toMatchObject({ owner: owner.address, label, threshold: 2n, revoked: false, recoveryActive: false });
	const onChain = await chain.guardiansAt(id, secret.version);
	expect(new Set(onChain)).toEqual(new Set(shares.map((s) => s.stealthAddress)));
	expect((await chain.shareAt(id, secret.version, shares[0].stealthAddress)).shareEncrypted).toBe(shares[0].shareEncrypted);
	return { id, owner, guardians, fromBlock, txHash: dispatch.txHash };
};

describe.skipIf(!live)('a secret on a live deployment', () => {
	const chain = deployment ? new RecoveryChain(deployment) : (null as never);

	it.skipIf(!deployment?.relayerUrl)('is created through the relayer, which pays the gas', async () => {
		const out = await createsSecret(chain, relayerGateway(deployment!.relayerUrl!));
		console.log(`relayer: secret ${out.id}, tx ${out.txHash}`);
	}, 120_000);

	it.skipIf(!env.RECOVERY_PAYER_KEY)('is created straight on the contract, and a round on it opened and vetoed', async () => {
		const gateway = directGateway(chain, env.RECOVERY_PAYER_KEY!);
		const { id, owner, guardians, fromBlock, txHash } = await createsSecret(chain, gateway);
		console.log(`direct: secret ${id}, tx ${txHash}`);

		const initiate = await signBound(chain, guardians[0].privateKey, 'InitiateRecovery', id, {});
		await gateway.initiateRecovery(initiate.body);
		expect(await chain.roundState(id)).toBe(RoundState.Voting);

		const cancel = await signBound(chain, owner.privateKey, 'CancelRecovery', id, {});
		await gateway.cancelRecovery(cancel.body);
		expect(await chain.roundState(id)).toBe(RoundState.None);

		const events = await chain.roundEvents(id, fromBlock);
		expect(events.map((e) => [e.type, e.round])).toEqual([['initiated', 1n], ['cancelled', 1n]]);
		expect(events[0]).toMatchObject({ initiator: guardians[0].address });
		// The same, read from the deployment's start: every log step, in batches.
		expect(await chain.roundEvents(id)).toEqual(events);
	}, 180_000);
});
