// A guardian finds their own slot of a version with their viewing key, and
// only theirs; its key controls the stealth address the owner registered.
import { describe, it, expect } from 'vitest';
import { computeAddress, SigningKey } from 'ethers';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf } from '@/lib/recovery/backupRun';
import { findMySlot } from '@/lib/recovery/guardianSlot';

const keys = [1, 2, 3].map((n) => metaKeysOf(new Uint8Array(32).fill(n)));
const run = prepareRun({
	deployment: 'x',
	owner: '0x' + '77'.repeat(20),
	guardians: keys.map((k, i) => ({ userHash: 'u_' + String(i + 1).repeat(128), metaAddress: k.metaAddress })),
	settings: defaultSettings(3, 3),
	nodes: ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` })),
	device: 'd',
	now: 1,
});
const inputs = shareInputsOf(run);
const chain = {
	guardiansAt: async () => inputs.map((s) => s.stealthAddress),
	shareAt: async (_id: string, _v: bigint, a: string) => inputs.find((s) => s.stealthAddress === a)!,
};

describe('a guardian’s own slot', () => {
	it('is found by each guardian’s keys, and its key controls that stealth address', async () => {
		for (const [i, k] of keys.entries()) {
			const slot = await findMySlot(chain, '0x', 1, k);
			expect(slot?.stealthAddress).toBe(inputs[i].stealthAddress);
			expect(computeAddress(new SigningKey(slot!.privateKey).publicKey).toLowerCase()).toBe(inputs[i].stealthAddress.toLowerCase());
		}
	});

	it('is not found for someone dropped from the version', async () => {
		expect(await findMySlot(chain, '0x', 1, metaKeysOf(new Uint8Array(32).fill(9)))).toBeNull();
	});
});
