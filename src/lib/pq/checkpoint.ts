// Signed DAG checkpoint: commitments over a dialog's causal history and its
// materialized view (ТЗ "Signed DAG Checkpoint + View Root").
//
// Two independent fingerprints travel inside an ordinary encrypted message
// (content type "checkpoint", registry 07):
//
// - frontier_root commits to the causal history: the set of DAG tails
//   (message_id → sign_hash revision pairs) observed at checkpoint time.
//   sign_hash already commits to a revision's full content transitively —
//   it is the hash of a signature over the canonical payload — so no second
//   content-addressing scheme is introduced.
// - view_root commits to what the user actually saw: a Merkle trie over
//   {message_id → (current revision, deleted)}. History and view are
//   separate commitments precisely so "history grew but the view is the
//   same" is distinguishable from "the visible conversation changed".
//
// The trie is a compressed binary Merkle trie keyed by the bytes of
// message_id: a leaf's position is a function of its key alone, so a
// late-arriving old message changes exactly one path and nothing else
// (Invariant 6 by construction), and display order needs no separate
// position field — order IS the key (UUIDv7 authoring time, 04_ordering).
//
// A checkpoint proves "this device held this causally complete local state",
// never "no other events existed elsewhere" — global completeness is
// explicitly not claimed.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

export const CHECKPOINT_VERSION = 1;
export const REDUCER_VERSION = 'dialog-state-v1';
export const TREE_VERSION = 'dialog-view-tree-v1';

const FRONTIER_DOMAIN = 'BUCKITUP_DIALOG_FRONTIER_V1';
const LEAF_DOMAIN = 'BUCKITUP_DIALOG_VIEW_LEAF_V1';
const NODE_DOMAIN = 'BUCKITUP_DIALOG_VIEW_NODE_V1';

const utf8 = (s: string) => new TextEncoder().encode(s);

const concatHash = (...parts: Uint8Array[]): Uint8Array => {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const buf = new Uint8Array(total);
	let off = 0;
	for (const p of parts) { buf.set(p, off); off += p.length; }
	return sha3_512(buf);
};

// ---------- frontier commitment ----------

/** The frontier as sent on the wire: message_id → sign_hash, like refs. */
export type Frontier = Record<string, string>;

/**
 * 'dfr_' + hex hash over the sorted "message_id|sign_hash" pairs. A plain
 * fast fingerprint; the frontier map itself stays the source of truth.
 */
export const deriveFrontierRoot = (frontier: Frontier): string => {
	const pairs = Object.entries(frontier).map(([mid, sh]) => `${mid}|${sh}`).sort();
	return 'dfr_' + bytesToHex(concatHash(utf8(FRONTIER_DOMAIN), utf8('\0' + pairs.join('\n'))));
};

// ---------- view state and Merkle trie ----------

/** What the reducer (dialog-state-v1) yields per logical message. */
export interface ViewLeafValue {
	/** sign_hash of the winning revision — commits content, edit chain and
	 * timestamps transitively, so edit→edit-back still changes the view. */
	signHash: string;
	deleted: boolean;
}

export type ViewState = Record<string, ViewLeafValue>; // message_id → value

export const deriveLeafHash = (messageId: string, value: ViewLeafValue): Uint8Array =>
	concatHash(utf8(LEAF_DOMAIN), utf8(`\0${messageId}\0${value.signHash}\0${value.deleted ? 'true' : 'false'}`));

interface TrieLeaf { kind: 'leaf'; key: string; keyBits: Uint8Array; value: ViewLeafValue; hash: Uint8Array }
interface TrieNode { kind: 'node'; bit: number; left: TrieBranch; right: TrieBranch; hash: Uint8Array }
type TrieBranch = TrieLeaf | TrieNode;

export interface ViewTree {
	root: string; // 'dvr_' + hex
	node: TrieBranch | null;
}

const bitAt = (bytes: Uint8Array, bit: number): number =>
	bit >= bytes.length * 8 ? 0 : (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;

const nodeHash = (bit: number, left: Uint8Array, right: Uint8Array): Uint8Array => {
	const idx = new Uint8Array(4);
	new DataView(idx.buffer).setUint32(0, bit);
	return concatHash(utf8(NODE_DOMAIN), idx, left, right);
};

const buildBranch = (entries: TrieLeaf[], fromBit: number): TrieBranch => {
	if (entries.length === 1) return entries[0];
	// lowest bit where the (sorted, unique) keys disagree: first vs last differ
	// there iff any pair does
	let bit = fromBit;
	const first = entries[0].keyBits;
	const last = entries[entries.length - 1].keyBits;
	while (bitAt(first, bit) === bitAt(last, bit)) bit++;
	const split = entries.findIndex((e) => bitAt(e.keyBits, bit) === 1);
	const left = buildBranch(entries.slice(0, split), bit + 1);
	const right = buildBranch(entries.slice(split), bit + 1);
	return { kind: 'node', bit, left, right, hash: nodeHash(bit, left.hash, right.hash) };
};

const EMPTY_ROOT = () => concatHash(utf8(NODE_DOMAIN), utf8('\0empty'));

/**
 * Deterministic for a given state regardless of construction or delivery
 * order: the shape depends only on the sorted key set. Dialog-sized states
 * rebuild in O(n) fast hashes; the structure still gives O(log n) proofs and
 * an exact recursive diff.
 */
export const buildViewTree = (state: ViewState): ViewTree => {
	const entries: TrieLeaf[] = Object.entries(state)
		.map(([key, value]) => ({
			kind: 'leaf' as const, key, keyBits: utf8(key), value, hash: deriveLeafHash(key, value),
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	if (entries.length === 0) return { root: 'dvr_' + bytesToHex(EMPTY_ROOT()), node: null };
	const node = buildBranch(entries, 0);
	return { root: 'dvr_' + bytesToHex(node.hash), node };
};

// ---------- diff ----------

export interface ViewDiff {
	added: string[];
	removed: string[];
	/** key → both values, for semantic classification */
	changed: Array<{ key: string; from: ViewLeafValue; to: ViewLeafValue }>;
}

const collectLeaves = (branch: TrieBranch | null, out: Map<string, TrieLeaf>): void => {
	if (!branch) return;
	if (branch.kind === 'leaf') { out.set(branch.key, branch); return; }
	collectLeaves(branch.left, out);
	collectLeaves(branch.right, out);
};

const hashEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Exact diff of two trees. Equal-hash branches are skipped wholesale; where
 * the structures disagree the leaves underneath are set-compared, so the
 * output lists precisely the logical messages whose value differs — never
 * neighbours dragged in by tree shape.
 */
export const diffViewTrees = (from: ViewTree, to: ViewTree): ViewDiff => {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: ViewDiff['changed'] = [];

	const walk = (a: TrieBranch | null, b: TrieBranch | null): void => {
		if (a && b && hashEq(a.hash, b.hash)) return;
		if (a?.kind === 'node' && b?.kind === 'node' && a.bit === b.bit) {
			walk(a.left, b.left);
			walk(a.right, b.right);
			return;
		}
		// shapes disagree — resolve by leaf sets under the two branches
		const la = new Map<string, TrieLeaf>();
		const lb = new Map<string, TrieLeaf>();
		collectLeaves(a, la);
		collectLeaves(b, lb);
		for (const [key, leaf] of la) {
			const other = lb.get(key);
			if (!other) removed.push(key);
			else if (!hashEq(leaf.hash, other.hash)) changed.push({ key, from: leaf.value, to: other.value });
		}
		for (const key of lb.keys()) if (!la.has(key)) added.push(key);
	};

	walk(from.node, to.node);
	return { added: added.sort(), removed: removed.sort(), changed: changed.sort((x, y) => (x.key < y.key ? -1 : 1)) };
};

// ---------- Merkle proof ----------

export interface ViewProofStep { bit: number; sibling: string; side: 'left' | 'right' }

/** Inclusion proof for one key; null when the key is absent. */
export const proveViewKey = (tree: ViewTree, key: string): ViewProofStep[] | null => {
	const keyBits = utf8(key);
	const path: ViewProofStep[] = [];
	let branch = tree.node;
	while (branch && branch.kind === 'node') {
		const goRight = bitAt(keyBits, branch.bit) === 1;
		path.push({
			bit: branch.bit,
			sibling: bytesToHex((goRight ? branch.left : branch.right).hash),
			side: goRight ? 'left' : 'right',
		});
		branch = goRight ? branch.right : branch.left;
	}
	if (!branch || branch.key !== key) return null;
	return path;
};

export const verifyViewProof = (
	root: string,
	key: string,
	value: ViewLeafValue,
	proof: ViewProofStep[],
): boolean => {
	let hash = deriveLeafHash(key, value);
	for (let i = proof.length - 1; i >= 0; i--) {
		const step = proof[i];
		const sibling = Uint8Array.from(step.sibling.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
		hash = step.side === 'left' ? nodeHash(step.bit, sibling, hash) : nodeHash(step.bit, hash, sibling);
	}
	return root === 'dvr_' + bytesToHex(hash);
};

// ---------- semantic classification ----------

export type DialogChange =
	| { type: 'MESSAGE_ADDED'; messageId: string }
	| { type: 'MESSAGE_REMOVED'; messageId: string }
	| { type: 'MESSAGE_EDITED'; messageId: string; oldVersion: string; newVersion: string }
	| { type: 'MESSAGE_DELETED'; messageId: string }
	| { type: 'MESSAGE_RESTORED'; messageId: string };

/** Checkpoint-relative reading of a raw view diff (old = checkpoint state). */
export const classifyChanges = (diff: ViewDiff): DialogChange[] => {
	const changes: DialogChange[] = [];
	for (const key of diff.added) changes.push({ type: 'MESSAGE_ADDED', messageId: key });
	// events are immutable, so a removal can only mean local state loss —
	// surfaced rather than silently dropped
	for (const key of diff.removed) changes.push({ type: 'MESSAGE_REMOVED', messageId: key });
	for (const { key, from, to } of diff.changed) {
		if (!from.deleted && to.deleted) changes.push({ type: 'MESSAGE_DELETED', messageId: key });
		else if (from.deleted && !to.deleted) changes.push({ type: 'MESSAGE_RESTORED', messageId: key });
		else changes.push({ type: 'MESSAGE_EDITED', messageId: key, oldVersion: from.signHash, newVersion: to.signHash });
	}
	return changes;
};
