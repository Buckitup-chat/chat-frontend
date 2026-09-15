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

export const CHECKPOINT_VERSION = 2;
export const REDUCER_VERSION = 'dialog-state-v1';
export const TREE_VERSION = 'dialog-view-tree-v3';

/** Everything a stored root's meaning depends on, in one stamp. A pointer
 * saved under a different stamp is incomparable and must be dropped, so a
 * future bump of ANY component invalidates it — not only the envelope
 * version. tests/pqCheckpoint golden vectors pin the actual bytes: any
 * change to the derivation fails there first and forces a conscious bump. */
export const CHECKPOINT_SEMANTICS = `${CHECKPOINT_VERSION}|${REDUCER_VERSION}|${TREE_VERSION}`;

const FRONTIER_DOMAIN = 'BUCKITUP_DIALOG_FRONTIER_V2';
const LEAF_DOMAIN = 'BUCKITUP_DIALOG_VIEW_LEAF_V2';
const NODE_DOMAIN = 'BUCKITUP_DIALOG_VIEW_NODE_V2';

const utf8 = (s: string) => new TextEncoder().encode(s);

// Every variable-length field in a hash pre-image is length-framed
// (u32be(len) || bytes). Delimiter-joined concatenation is not injective
// when the joined strings are attacker-controlled: {"A|X\nB": "Y"} and
// {"A": "X", "B": "Y"} would collapse to one pre-image, letting two
// structurally different frontiers share a root — the exact property a
// commitment must not have.
const u32 = (n: number): Uint8Array => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n);
	return b;
};
const framed = (b: Uint8Array): Uint8Array[] => [u32(b.length), b];

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
 * 'dfr_' + hex hash over the sorted, length-framed (message_id, sign_hash)
 * pairs. A plain fast fingerprint; the frontier map itself stays the source
 * of truth.
 */
export const deriveFrontierRoot = (frontier: Frontier): string => {
	const pairs = Object.entries(frontier).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const parts: Uint8Array[] = [utf8(FRONTIER_DOMAIN), u32(pairs.length)];
	for (const [mid, sh] of pairs) parts.push(...framed(utf8(mid)), ...framed(utf8(sh)));
	return 'dfr_' + bytesToHex(concatHash(...parts));
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
	concatHash(
		utf8(LEAF_DOMAIN),
		...framed(utf8(messageId)),
		...framed(utf8(value.signHash)),
		Uint8Array.of(value.deleted ? 1 : 0),
	);

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

// The version is mixed in explicitly: the empty dialog is the one state
// whose root no leaf-hash change would otherwise touch, and roots from
// different tree semantics must never compare equal.
const EMPTY_ROOT = () => concatHash(utf8(NODE_DOMAIN), ...framed(utf8(TREE_VERSION)), utf8('empty'));

/**
 * Deterministic for a given state regardless of construction or delivery
 * order: the shape depends only on the sorted key set. Dialog-sized states
 * rebuild in O(n) fast hashes; the structure still gives O(log n) proofs and
 * an exact recursive diff.
 */
export const buildViewTree = (state: ViewState): ViewTree => {
	// Keys are sorted as UTF-16 strings but walked as UTF-8 bytes; the two
	// orders agree only on ASCII. dmsg_ keys are ASCII by grammar — anything
	// else is a caller reusing the trie outside its domain, where
	// buildBranch's divergence scan is not guaranteed to terminate.
	// Checked per code unit (an \x00-\x7f regex trips no-control-regex):
	// every unit ≤ 0x7f, at least one unit. NUL and DEL stay allowed as
	// before; any surrogate half is > 0x7f and rejects.
	for (const key of Object.keys(state)) {
		let ascii = key.length > 0;
		for (let i = 0; ascii && i < key.length; i++) ascii = key.charCodeAt(i) <= 0x7f;
		if (!ascii) throw new TypeError(`view tree key is not ASCII: ${key}`);
	}
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

const SIBLING_HEX = /^[0-9a-f]{128}$/;

/** Returns false rather than throwing on malformed input, like the rest of
 * the verification layer (signature.ts). */
export const verifyViewProof = (
	root: string,
	key: string,
	value: ViewLeafValue,
	proof: ViewProofStep[],
): boolean => {
	if (!Array.isArray(proof)) return false;
	let hash = deriveLeafHash(key, value);
	for (let i = proof.length - 1; i >= 0; i--) {
		const step = proof[i];
		if (
			!step || typeof step.sibling !== 'string' || !SIBLING_HEX.test(step.sibling) ||
			(step.side !== 'left' && step.side !== 'right') ||
			!Number.isInteger(step.bit) || step.bit < 0
		) return false;
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
	| { type: 'MESSAGE_DELETED'; messageId: string; oldVersion: string; newVersion: string }
	| { type: 'MESSAGE_RESTORED'; messageId: string; oldVersion: string; newVersion: string };

/**
 * Checkpoint-relative reading of a raw view diff (old = checkpoint state).
 * Every change names both revisions, so a UI can resolve and show the
 * concrete before/after content — for a delete, oldVersion is what the
 * message said before the tombstone.
 */
export const classifyChanges = (diff: ViewDiff): DialogChange[] => {
	const changes: DialogChange[] = [];
	for (const key of diff.added) changes.push({ type: 'MESSAGE_ADDED', messageId: key });
	// events are immutable, so a removal can only mean local state loss —
	// surfaced rather than silently dropped
	for (const key of diff.removed) changes.push({ type: 'MESSAGE_REMOVED', messageId: key });
	for (const { key, from, to } of diff.changed) {
		const versions = { oldVersion: from.signHash, newVersion: to.signHash };
		if (!from.deleted && to.deleted) changes.push({ type: 'MESSAGE_DELETED', messageId: key, ...versions });
		else if (from.deleted && !to.deleted) changes.push({ type: 'MESSAGE_RESTORED', messageId: key, ...versions });
		else changes.push({ type: 'MESSAGE_EDITED', messageId: key, ...versions });
	}
	return changes;
};
