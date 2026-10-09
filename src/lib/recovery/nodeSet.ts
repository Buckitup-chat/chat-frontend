// The nodes that hold a version's node half, as the owner chose them
// (chat repo: pq_recovery_services § Choosing nodes). A recovering device
// knows nothing else, so the set rides with every share and is hashed into
// the split's root (pq_recovery_shares § Re-issuing): a guardian who rewrites
// it in a return fails the root check like one who rewrites a share.
import { sha3_512 } from '@noble/hashes/sha3';
import { concatBytes } from '@noble/hashes/utils';
import type { NodeSet } from '@/lib/pq/content';

export type { NodeSet };

export class NodeSetError extends Error {}

const MAX_NODES = 16;
/** An entry's length is hashed as a u16. */
const MAX_ENTRY_BYTES = 0xffff;
/** `n_` + 16 bytes of the node key's SHA3-256, lowercase hex. */
const NODE_ID = /^n_[0-9a-f]{32}$/;

/** The id and URL of one entry; throws NodeSetError unless both are well formed. */
export const parseNodeEntry = (entry: string): { id: string; url: string } => {
	if (new TextEncoder().encode(entry).length > MAX_ENTRY_BYTES) throw new NodeSetError('a node entry is longer than its length field holds');
	const at = entry.indexOf('@');
	const id = entry.slice(0, at);
	const url = entry.slice(at + 1);
	if (at < 0 || !NODE_ID.test(id)) throw new NodeSetError(`not a node id: ${entry}`);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new NodeSetError(`not a URL: ${entry}`);
	}
	// The string is hashed and fetched as it is, so it must already be the URL's
	// canonical serialization: no case, whitespace, backslash or encoding
	// variant of the same address, which builds would read differently.
	if (parsed.href !== url) throw new NodeSetError(`a node URL is in canonical form: ${entry}`);
	if (parsed.protocol !== 'https:') throw new NodeSetError(`a node URL is https: ${entry}`);
	if (parsed.username || parsed.password) throw new NodeSetError(`a node URL carries no credentials: ${entry}`);
	return { id, url };
};

/** Throws NodeSetError unless `set` obeys the wire rules (07 § recovery_share, node_set). */
export const checkNodeSet = (set: NodeSet): void => {
	const n = set.nodes.length;
	if (!Number.isInteger(set.threshold) || set.threshold < 2 || set.threshold > n || n > MAX_NODES) {
		throw new NodeSetError(`a node set has 2 ≤ threshold ≤ nodes ≤ ${MAX_NODES}`);
	}
	const ids = set.nodes.map((entry) => parseNodeEntry(entry).id);
	if (new Set(ids).size !== ids.length) throw new NodeSetError('a node appears twice in the set');
};

/** `SHA3-512(u8(threshold) || u8(n) || entry_1 || … || entry_n)`, each entry `u16be(len) || utf8`. */
export const nodeSetHash = (set: NodeSet): Uint8Array => {
	checkNodeSet(set);
	const entries = set.nodes.map((entry) => {
		const bytes = new TextEncoder().encode(entry);
		return concatBytes(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
	});
	return sha3_512(concatBytes(Uint8Array.of(set.threshold, set.nodes.length), ...entries));
};
