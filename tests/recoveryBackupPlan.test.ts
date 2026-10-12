// The setup rules of a community backup and the node set the client suggests
// (pq_recovery_shares § Issuing; pq_recovery_services § Choosing nodes).
import { describe, it, expect } from 'vitest';
import { defaultSettings, durationText, healthOf, neededGuardians, relayerCanTake, settingsProblems, majority, SPARES_BOUNDS } from '@/lib/recovery/backupPlan';
import { BUCKITUP, defaultNodeSet, dominantOperator, guardianRunning, refusalOf, setProblems, type KnownNode } from '@/lib/recovery/nodeChoice';
import type { NodeDescriptor } from '@/lib/recovery/nodeClient';

describe('the defaults', () => {
	it('need a majority of the guardians, never fewer than 2', () => {
		expect([2, 3, 4, 5, 6].map(majority)).toEqual([2, 2, 3, 3, 4]);
		expect(defaultSettings(4, 5)).toEqual({ threshold: 3, approvals: 3, spares: 2, delaySec: 3 * 86400, windowSec: 7 * 86400, nodeThreshold: 3 });
		expect(defaultSettings(2, 3)).toMatchObject({ threshold: 2, approvals: 2, nodeThreshold: 2 });
	});

	it('are valid for 2 to 50 guardians', () => {
		for (let g = 2; g <= 50; g++) expect(settingsProblems(defaultSettings(g, 3), g, 3)).toEqual([]);
	});
});

describe('a setup is refused', () => {
	const ok = defaultSettings(4, 5);

	it('with fewer than 2 guardians, or more than the contract takes', () => {
		expect(settingsProblems(defaultSettings(1, 5), 1, 5)).toContainEqual({ field: 'guardians', reason: 'too_few' });
		expect(settingsProblems(ok, 51, 5)).toContainEqual({ field: 'guardians', reason: 'too_many' });
	});

	it('with fewer approvals than shares needed, which no honest recovery could meet', () => {
		expect(settingsProblems({ ...ok, threshold: 4, approvals: 3 }, 4, 5)).toEqual([{ field: 'approvals', reason: 'below_threshold' }]);
		expect(settingsProblems({ ...ok, approvals: 5 }, 4, 5)).toEqual([{ field: 'approvals', reason: 'above_guardians' }]);
	});

	it('with a threshold, wait, window or node threshold out of bounds', () => {
		expect(settingsProblems({ ...ok, threshold: 5, approvals: 5 }, 4, 5)).toContainEqual({ field: 'threshold', reason: 'out_of_range' });
		expect(settingsProblems({ ...ok, delaySec: 599 }, 4, 5)).toEqual([{ field: 'delaySec', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, windowSec: 31 * 86400 }, 4, 5)).toEqual([{ field: 'windowSec', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, nodeThreshold: 6 }, 4, 5)).toEqual([{ field: 'nodeThreshold', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, spares: 252 }, 4, 5)).toEqual([{ field: 'spares', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, spares: SPARES_BOUNDS.max }, 4, 5)).toEqual([]);
		expect(settingsProblems({ ...ok, spares: SPARES_BOUNDS.max + 1 }, 4, 5)).toEqual([{ field: 'spares', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, spares: -1 }, 4, 5)).toEqual([{ field: 'spares', reason: 'out_of_range' }]);
		// The pieces must outnumber the guardians: at least one spare.
		expect(SPARES_BOUNDS.min).toBe(1);
		expect(settingsProblems({ ...ok, spares: 0 }, 4, 5)).toEqual([{ field: 'spares', reason: 'out_of_range' }]);
		// A node threshold leaves a spare node.
		expect(settingsProblems({ ...ok, nodeThreshold: 5 }, 4, 5)).toEqual([{ field: 'nodeThreshold', reason: 'out_of_range' }]);
		expect(settingsProblems({ ...ok, nodeThreshold: 4 }, 4, 5)).toEqual([]);
	});
});

describe('the health line', () => {
	it('counts holders against the larger of shares and approvals needed', () => {
		expect(neededGuardians({ threshold: 2, approvals: 3 })).toBe(3);
		expect([4, 3, 2, 1].map((h) => healthOf(h, 2))).toEqual(['spare_2', 'spare_1', 'at_threshold', 'broken']);
	});

	it('the free service takes at most 32 guardians', () => {
		expect(relayerCanTake(32)).toBe(true);
		expect(relayerCanTake(33)).toBe(false);
	});

	it('says durations as the screens do', () => {
		expect([3 * 86400, 86400, 7200, 600].map(durationText)).toEqual(['3 days', '1 day', '2 hours', '10 minutes']);
	});
});

const node = (id: string, operator: string, over: Partial<NodeDescriptor> = {}, online = true): KnownNode => ({
	descriptor: {
		id,
		url: `https://${id}.example/recovery/node`,
		chain: 'eip155:11155111',
		contract: '0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7',
		operator,
		issued_at: 1,
		node_pubkey: '0x02',
		node_sig: '0x',
		operator_sig: 'sig',
		...over,
	},
	online,
});
const U = (c: string) => 'u_' + c.repeat(128);
const BU = [U('b'), U('c')];

describe('choosing nodes', () => {
	it('refuses a node that is offline, or run by a guardian or their organisation', () => {
		expect(refusalOf(node('n1', U('1'), {}, false), [], BU)).toBe('offline');
		expect(refusalOf(node('n1', U('1')), [U('1')], BU)).toBe('guardian_operator');
		// A guardian who is a BuckitUp account makes every BuckitUp node a guardian's.
		expect(refusalOf(node('n1', U('b')), [U('c')], BU)).toBe('guardian_operator');
		expect(refusalOf(node('n1', U('1')), [U('2')], BU)).toBeNull();
	});

	it('names the guardian who runs a node, online or not', () => {
		expect(guardianRunning(node('n1', U('2')), [U('1'), U('2')], BU)).toBe(U('2'));
		expect(guardianRunning(node('n1', U('2'), {}, false), [U('2')], BU)).toBe(U('2'));
		// Any BuckitUp account runs every BuckitUp node.
		expect(guardianRunning(node('n1', U('b')), [U('c')], BU)).toBe(U('c'));
		expect(guardianRunning(node('n1', U('1')), [U('2')], BU)).toBeNull();
		const refused = setProblems([node('n1', U('2')), node('n2', U('3')), node('n3', U('4'), {}, false)], 2, [U('2')], BU);
		expect(refused).toEqual(
			expect.arrayContaining([
				{ kind: 'refused_node', nodeId: 'n1', reason: 'guardian_operator', guardian: U('2') },
				{ kind: 'refused_node', nodeId: 'n3', reason: 'offline', guardian: null },
			]),
		);
	});

	it('counts operators, not nodes', () => {
		const set = [node('n1', U('b')), node('n2', U('c')), node('n3', U('1'))];
		expect(dominantOperator(set, 2, BU)).toBe(BUCKITUP);
		expect(setProblems(set, 2, [], BU)).toEqual(
			expect.arrayContaining([{ kind: 'too_few_operators', have: 2, need: 3 }, { kind: 'dominant_operator', operator: BUCKITUP }]),
		);
		const fine = [node('n1', U('b')), node('n2', U('1')), node('n3', U('2'))];
		expect(setProblems(fine, 2, [], BU)).toEqual([]);
	});

	it('wants a node threshold of at least 2 and a spare node', () => {
		const three = [node('n1', U('1')), node('n2', U('2')), node('n3', U('3'))];
		expect(setProblems(three, 3, [], BU)).toEqual([{ kind: 'threshold', threshold: 3, nodes: 3 }]);
		expect(setProblems(three, 1, [], BU)).toContainEqual({ kind: 'threshold', threshold: 1, nodes: 3 });
		const suggested = defaultNodeSet(three, [], BU);
		expect(suggested.threshold).toBe(2);
		expect(setProblems(suggested.nodes, suggested.threshold, [], BU)).toEqual([]);
		expect(defaultSettings(4, 3).nodeThreshold).toBe(2);
	});

	it('suggests one node per operator, BuckitUp first, up to five, a majority needed', () => {
		const known = [
			node('a', U('1'), { issued_at: 1 }),
			node('a2', U('1'), { issued_at: 2 }),
			node('b', U('2')),
			node('bu1', U('b')),
			node('bu2', U('c')),
			node('c', U('3')),
			node('d', U('4')),
			node('e', U('5')),
			node('g', U('9')), // a guardian's
			node('off', U('6'), {}, false),
		];
		const { nodes, threshold, missingOperators } = defaultNodeSet(known, [U('9')], BU);
		expect(nodes.map((n) => n.descriptor.id)).toEqual(['bu1', 'a2', 'b', 'c', 'd']);
		expect(threshold).toBe(3);
		expect(missingOperators).toBe(0);
		expect(setProblems(nodes, threshold, [U('9')], BU)).toEqual([]);
	});

	it('says how many operators are missing', () => {
		expect(defaultNodeSet([node('a', U('1')), node('b', U('2'))], [], BU)).toMatchObject({ missingOperators: 1 });
	});
});
