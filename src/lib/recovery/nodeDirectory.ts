// The nodes this client knows, checked (chat repo: pq_recovery_services
// § Choosing nodes): the server it syncs with, and any address the owner typed
// in. Each is asked for its descriptor, which must verify — the node key, the
// URL it was fetched from, the deployment, the operator's endorsement under
// their verified card — and for its health.
import { fetchDescriptor, isPrivateHost, isStableNodeUrl, nodeIsUp, verifyDescriptor, type DescriptorVerdict } from './nodeClient';
import type { KnownNode } from './nodeChoice';
import type { Deployment } from './deployments';
import type { VerifiedCard } from '@/lib/pq/verifyCard';

export type NodeCheck =
	| { state: 'ready'; node: KnownNode }
	| { state: 'refused'; reason: 'private_address' | 'not_https' | 'unreachable' | Exclude<DescriptorVerdict, { ok: true }>['reason'] };

export interface DirectoryDeps {
	deployment: Pick<Deployment, 'chainId' | 'secretRecovery'>;
	/** The operator's verified card, or null when their card does not verify here. */
	operatorCard: (userHash: string) => Promise<VerifiedCard | null>;
	fetch?: typeof fetch;
}

/** Whether `url`, whatever its scheme, names a host only a home or office network reaches. */
const isPrivateAddress = (url: string): boolean => {
	try {
		return isPrivateHost(new URL(url).hostname);
	} catch {
		return false;
	}
};

/** Checks the node at `url`, as the Add-node screen does field by field. */
export const checkNode = async (url: string, deps: DirectoryDeps): Promise<NodeCheck> => {
	if (!isStableNodeUrl(url)) return { state: 'refused', reason: isPrivateAddress(url) ? 'private_address' : 'not_https' };
	let descriptor: unknown;
	try {
		descriptor = await fetchDescriptor(url, { fetch: deps.fetch });
	} catch {
		return { state: 'refused', reason: 'unreachable' };
	}
	const operator = (descriptor as { operator?: unknown })?.operator;
	const card = typeof operator === 'string' ? await deps.operatorCard(operator) : null;
	const verdict = verifyDescriptor(descriptor, { url, deployment: deps.deployment }, card);
	if (!verdict.ok) return { state: 'refused', reason: verdict.reason };
	const online = await nodeIsUp({ id: verdict.descriptor.id, url }, { fetch: deps.fetch });
	return { state: 'ready', node: { descriptor: verdict.descriptor, online } };
};

/** Every address checked; those that verify, as known nodes. */
export const knownNodes = async (urls: readonly string[], deps: DirectoryDeps): Promise<{ nodes: KnownNode[]; refused: Record<string, NodeCheck> }> => {
	const checks = await Promise.all([...new Set(urls)].map(async (url) => [url, await checkNode(url, deps)] as const));
	const nodes: KnownNode[] = [];
	const refused: Record<string, NodeCheck> = {};
	for (const [url, check] of checks) {
		if (check.state === 'ready') nodes.push(check.node);
		else refused[url] = check;
	}
	return { nodes, refused };
};

/** The node path on the server this client syncs with, as node_set would list it. */
export const syncedServerNode = (apiBase: string, origin: string): string | null => {
	try {
		const u = new URL(apiBase, origin);
		return `${u.origin}/recovery/node`;
	} catch {
		return null;
	}
};
