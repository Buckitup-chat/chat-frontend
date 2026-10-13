// The recovering device's verdicts (pq_recovery_shares § Returning): the
// request it answers, the binding it answers with, the round as it stands for
// its candidate, and which returned shares count. A real split, real keys.
import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, sharePartOf } from '@/lib/recovery/backupRun';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { returnOf } from '@/lib/recovery/recovering';
import { checkBinding, recoveryWords } from '@/lib/recovery/recoveryBinding';
import {
	bindingFor,
	canRestart,
	candidateOf,
	chosenSecret,
	findSecretRef,
	helpRequestText,
	judgeReturns,
	newCandidateKey,
	nodesOf,
	roundViewOf,
	setAsideGuardians,
} from '@/lib/recovery/restoring';
import type { SecretState } from '@/lib/recovery/chain';

const REF = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7/0x' + 'ab'.repeat(32);
const TEMP = 'u_' + 'c'.repeat(128);
const G = (n: number) => 'u_' + String(n).repeat(128);

describe('a guardian\'s request', () => {
	it('carries the secret_ref, read out of the text it is in', () => {
		expect(findSecretRef(helpRequestText(REF))).toBe(REF);
		expect(findSecretRef(`  ${REF}\n`)).toBe(REF);
		expect(findSecretRef(`${REF} and again ${REF}`)).toBe(REF);
	});

	it('names one backup, canonically, or none', () => {
		expect(findSecretRef('hello')).toBeNull();
		expect(findSecretRef(REF.toUpperCase())).toBeNull();
		expect(findSecretRef(`${REF} ${REF.replace('ab', 'ac')}`)).toBeNull();
		expect(findSecretRef(REF + 'ff')).toBeNull();
		expect(findSecretRef(42)).toBeNull();
	});

	it('the recovery follows the backup most guardians asked about, and of equals the first asked', () => {
		const other = REF.replace('ab', 'cd');
		expect(chosenSecret([])).toBeNull();
		expect(chosenSecret([{ peer: G(9), secretRef: other, messageId: 'dmsg_1' }, { peer: G(1), secretRef: REF, messageId: 'dmsg_2' }, { peer: G(2), secretRef: REF, messageId: 'dmsg_3' }])).toBe(REF);
		expect(chosenSecret([{ peer: G(1), secretRef: REF, messageId: 'dmsg_2' }, { peer: G(9), secretRef: other, messageId: 'dmsg_1' }])).toBe(other);
		// One peer asking twice is one guardian.
		expect(chosenSecret([{ peer: G(9), secretRef: other, messageId: 'dmsg_1' }, { peer: G(9), secretRef: other, messageId: 'dmsg_4' }, { peer: G(1), secretRef: REF, messageId: 'dmsg_2' }, { peer: G(2), secretRef: REF, messageId: 'dmsg_3' }])).toBe(REF);
	});
});

describe('the answer', () => {
	it('binds a fresh candidate to this account, as the guardian checks it, with the words both screens show', () => {
		const key = newCandidateKey();
		expect(key).not.toBe(newCandidateKey());
		const binding = bindingFor(key, REF, TEMP);
		expect(binding.candidate).toBe(candidateOf(key));
		expect(checkBinding(binding, { secretRef: REF, dialogPeerUserHash: TEMP })).toBe(binding.candidate);
		expect(recoveryWords(REF, binding.candidate, TEMP)).toHaveLength(10);
	});
});

const secret = (over: Partial<SecretState> = {}): SecretState => ({
	owner: '0x' + '77'.repeat(20),
	revoked: false,
	label: 'bu',
	threshold: 2n,
	recoveryDelay: 600n,
	recoveryWindow: 3600n,
	recoveryRound: 3n,
	recoveryActive: true,
	recoveryRecipient: '0x' + '00'.repeat(20),
	executeAfter: 0n,
	version: 2n,
	...over,
});

describe('the round, for this device', () => {
	const me = '0x' + '5a'.repeat(20);
	const elected = { recoveryRecipient: '0x' + '5A'.repeat(20), executeAfter: 1000n };

	it('follows voting, the timelock and the window, with the countdowns', () => {
		expect(roundViewOf(secret({ recoveryActive: false }), RoundState.None, me, null, 0)).toMatchObject({ phase: 'none' });
		expect(roundViewOf(secret(), RoundState.Voting, me, null, 0)).toMatchObject({ phase: 'voting', quorum: 2, executeAfter: 0, expiresAt: 0 });
		expect(roundViewOf(secret(elected), RoundState.TimeLock, me, 3, 500)).toMatchObject({ phase: 'timelock', executeAfter: 1000, expiresAt: 4600 });
		expect(roundViewOf(secret(elected), RoundState.Window, me, 3, 2000)).toMatchObject({ phase: 'window' });
	});

	it('tells a veto, an expired window and another device apart — and each can start over', () => {
		const stopped = roundViewOf(secret({ recoveryActive: false }), RoundState.None, me, 3, 0);
		expect(stopped.phase).toBe('stopped');
		// A round never seen open is not a veto.
		expect(roundViewOf(secret({ recoveryActive: false }), RoundState.None, me, 2, 0).phase).toBe('none');
		expect(roundViewOf(secret(elected), RoundState.Expired, me, 3, 9000).phase).toBe('expired');
		// The chain's clock trails ours: past expiresAt is expired, whatever the state still says.
		expect(roundViewOf(secret(elected), RoundState.Window, me, 3, 4600).phase).toBe('expired');
		expect(roundViewOf(secret({ ...elected, recoveryRecipient: '0x' + '11'.repeat(20) }), RoundState.TimeLock, me, 3, 0).phase).toBe('elsewhere');
		for (const p of ['expired', 'stopped', 'elsewhere'] as const) expect(canRestart(p)).toBe(true);
		for (const p of ['none', 'voting', 'timelock', 'window'] as const) expect(canRestart(p)).toBe(false);
	});
});

describe('returned shares', () => {
	const run = {
		...prepareRun({
			deployment: 'x',
			owner: '0x' + '77'.repeat(20),
			guardians: [1, 2, 3].map((n) => ({ userHash: G(n), metaAddress: metaKeysOf(new Uint8Array(32).fill(n)).metaAddress })),
			settings: defaultSettings(3, 3),
			nodes: ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` })),
			device: 'd',
			now: 1,
		}),
		version: 2,
	};
	const CANDIDATE = '0x' + '5a'.repeat(20);
	const expected = { secretRef: REF, version: 2, round: 3, candidate: CANDIDATE };
	const ret = (i: number, over = {}) => {
		const { kind: _k, ...share } = sharePartOf(run, i, REF, 1);
		return { ...returnOf(share, 3, CANDIDATE, 5), ...over };
	};
	const root = hexToBytes(run.root);

	it('count once per share index, and name the nodes to ask', () => {
		const judged = judgeReturns(
			[
				{ sender: G(1), via: 'dialog', part: ret(0) },
				{ sender: G(1), via: 'text', part: ret(0) },
				{ sender: G(2), via: 'dialog', part: ret(1) },
			],
			expected,
			root,
		);
		expect(judged.verified.map((v) => v.sender)).toEqual([G(1), G(1), G(2)]);
		expect(judged.distinct).toBe(2);
		expect(judged.threshold).toBe(run.settings.threshold);
		expect(nodesOf(judged.nodeSet)).toEqual(run.nodes);
		expect(judged.setAside).toEqual([]);
	});

	it('are set aside with their sender named when they do not check, and ignored when for another backup, round or device', () => {
		const edited = ret(2);
		edited.shareB64 = edited.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
		const judged = judgeReturns(
			[
				{ sender: G(1), via: 'dialog', part: ret(0, { round: 2 }) },
				{ sender: G(1), via: 'dialog', part: ret(0, { candidate: '0x' + '11'.repeat(20) }) },
				{ sender: G(3), via: 'dialog', part: edited },
				{ sender: G(2), via: 'dialog', part: ret(1, { secretRef: REF.replace('ab', 'cd') }) },
				{ sender: G(2), via: 'dialog', part: ret(1, { version: 1 }) },
			],
			expected,
			root,
		);
		expect(judged.verified).toEqual([]);
		expect(judged.setAside).toEqual([
			{ sender: G(3), via: 'dialog', reason: expect.any(String) },
			{ sender: G(2), via: 'dialog', reason: expect.stringMatching(/another backup or version/) },
		]);
		expect(setAsideGuardians(judged)).toEqual([G(3), G(2)]);
		expect(judged.distinct).toBe(0);
		expect(judged.nodeSet).toBeNull();
	});

	it('name no guardian who also returned a piece that checks', () => {
		const edited = ret(0);
		edited.shareB64 = edited.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
		const judged = judgeReturns([{ sender: G(1), via: 'dialog', part: edited }, { sender: G(1), via: 'text', part: ret(0) }], expected, root);
		expect(judged.setAside).toHaveLength(1);
		expect(setAsideGuardians(judged)).toEqual([]);
	});

	it('are set aside when the version holds no root to check them against', () => {
		const judged = judgeReturns([{ sender: G(1), via: 'dialog', part: ret(0) }], expected, null);
		expect(judged.setAside).toEqual([{ sender: G(1), via: 'dialog', reason: expect.stringMatching(/checksum/) }]);
	});
});
