// Which nodes may hold a secret's node half, and the set the client suggests
// (chat repo: pq_recovery_services § Choosing nodes). Pure: the client hands
// in the nodes it knows, already checked by nodeClient.verifyDescriptor, and
// gets back what can be offered, why the rest cannot, and the default set.
import type { NodeDescriptor } from './nodeClient';
import { MAX_DEFAULT_NODES, MIN_NODE_OPERATORS, majority } from './backupPlan';

/**
 * The accounts BuckitUp runs its nodes under: one operator, under the same
 * rules as anyone's (§ Choosing nodes, "An operator is an account or a set of
 * accounts"). Every other account is its own operator until sets are
 * published (that section's open question).
 */
export const BUCKITUP_OPERATOR_ACCOUNTS: readonly string[] = [];
export const BUCKITUP = 'buckitup';

/** The operator a node counts toward: BuckitUp for its accounts, the account itself otherwise. */
export const operatorOf = (operatorUserHash: string, buckitup: readonly string[] = BUCKITUP_OPERATOR_ACCOUNTS): string =>
	buckitup.includes(operatorUserHash) ? BUCKITUP : operatorUserHash;

/** A node the client knows: its verified descriptor, and whether it answered its health check recently. */
export interface KnownNode {
	descriptor: NodeDescriptor;
	online: boolean;
}

export type NodeRefusal = 'offline' | 'guardian_operator';

/**
 * Why `node` cannot hold this secret's node half, or null. A node whose
 * descriptor did not verify never gets here. One run by a guardian — any
 * account of its operator among them — would put both halves with one party.
 */
export const refusalOf = (node: KnownNode, guardians: readonly string[], buckitup: readonly string[] = BUCKITUP_OPERATOR_ACCOUNTS): NodeRefusal | null => {
	if (!node.online) return 'offline';
	const op = operatorOf(node.descriptor.operator, buckitup);
	const guardianOps = new Set(guardians.map((g) => operatorOf(g, buckitup)));
	if (guardianOps.has(op)) return 'guardian_operator';
	return null;
};

/** An operator holding `threshold` or more of the set's nodes, which could open the node half alone. */
export const dominantOperator = (nodes: readonly KnownNode[], threshold: number, buckitup: readonly string[] = BUCKITUP_OPERATOR_ACCOUNTS): string | null => {
	const count = new Map<string, number>();
	for (const n of nodes) {
		const op = operatorOf(n.descriptor.operator, buckitup);
		count.set(op, (count.get(op) ?? 0) + 1);
	}
	for (const [op, c] of count) if (c >= threshold) return op;
	return null;
};

export type SetProblem =
	| { kind: 'too_few_operators'; have: number; need: number }
	| { kind: 'dominant_operator'; operator: string }
	| { kind: 'refused_node'; nodeId: string; reason: NodeRefusal }
	| { kind: 'threshold'; threshold: number; nodes: number };

/** Everything wrong with a chosen set of nodes and its threshold, for these guardians. */
export const setProblems = (nodes: readonly KnownNode[], threshold: number, guardians: readonly string[], buckitup: readonly string[] = BUCKITUP_OPERATOR_ACCOUNTS): SetProblem[] => {
	const out: SetProblem[] = [];
	for (const n of nodes) {
		const reason = refusalOf(n, guardians, buckitup);
		if (reason) out.push({ kind: 'refused_node', nodeId: n.descriptor.id, reason });
	}
	const operators = new Set(nodes.map((n) => operatorOf(n.descriptor.operator, buckitup)));
	if (operators.size < MIN_NODE_OPERATORS) out.push({ kind: 'too_few_operators', have: operators.size, need: MIN_NODE_OPERATORS });
	if (!Number.isInteger(threshold) || threshold < 2 || threshold > nodes.length) out.push({ kind: 'threshold', threshold, nodes: nodes.length });
	const dominant = dominantOperator(nodes, threshold, buckitup);
	if (dominant) out.push({ kind: 'dominant_operator', operator: dominant });
	return out;
};

/**
 * The suggested set: the nodes that can be offered for these guardians, one
 * per operator — so no operator dominates by construction and BuckitUp gives
 * at most one — up to five, the threshold a majority. The newest descriptor
 * wins among one operator's nodes. Short of three operators, it says how many
 * more the owner has to add.
 */
export const defaultNodeSet = (
	known: readonly KnownNode[],
	guardians: readonly string[],
	buckitup: readonly string[] = BUCKITUP_OPERATOR_ACCOUNTS,
): { nodes: KnownNode[]; threshold: number; missingOperators: number } => {
	const perOperator = new Map<string, KnownNode>();
	for (const n of known) {
		if (refusalOf(n, guardians, buckitup)) continue;
		const op = operatorOf(n.descriptor.operator, buckitup);
		const prev = perOperator.get(op);
		if (!prev || n.descriptor.issued_at > prev.descriptor.issued_at) perOperator.set(op, n);
	}
	// BuckitUp's node first when there is one: it is the one most likely to stay up.
	const nodes = [...perOperator.entries()]
		.sort(([a], [b]) => (a === BUCKITUP ? -1 : b === BUCKITUP ? 1 : 0))
		.map(([, n]) => n)
		.slice(0, MAX_DEFAULT_NODES);
	return { nodes, threshold: majority(nodes.length), missingOperators: Math.max(0, MIN_NODE_OPERATORS - nodes.length) };
};
