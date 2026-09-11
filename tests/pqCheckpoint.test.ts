// Checkpoint commitments (ТЗ "Signed DAG Checkpoint + View Root"): the
// frontier fingerprint, the keyed Merkle trie behind view_root, its diff and
// proofs, and the wire envelope. Determinism across delivery order and
// "a late insert touches nothing but itself" are the security invariants
// (3, 6, 7) — they get their own tests.
import { describe, it, expect } from 'vitest';
import {
	deriveFrontierRoot, buildViewTree, diffViewTrees, classifyChanges,
	proveViewKey, verifyViewProof,
	CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION,
} from '@/lib/pq/checkpoint';
import { encodeContent, decodeContent, previewText, ContentDecodeError } from '@/lib/pq/content';

const mid = (n: number) => `dmsg_${String(n).padStart(4, '0')}e8f0-aaaa-7bbb-8ccc-ddddeeee${String(n).padStart(4, '0')}`;
const sh = (n: number) => 'dms_' + String(n % 10).repeat(128);

const state = (n: number, tweak: Record<string, { signHash: string; deleted: boolean }> = {}) => {
	const out: Record<string, { signHash: string; deleted: boolean }> = {};
	for (let i = 0; i < n; i++) out[mid(i)] = { signHash: sh(i), deleted: false };
	return { ...out, ...tweak };
};

describe('frontier root', () => {
	it('is independent of pair order', () => {
		const a = deriveFrontierRoot({ [mid(1)]: sh(1), [mid(2)]: sh(2) });
		const b = deriveFrontierRoot({ [mid(2)]: sh(2), [mid(1)]: sh(1) });
		expect(a).toBe(b);
		expect(a).toMatch(/^dfr_[0-9a-f]{128}$/);
	});

	it('changes with any revision and distinguishes the empty frontier', () => {
		const base = deriveFrontierRoot({ [mid(1)]: sh(1) });
		expect(deriveFrontierRoot({ [mid(1)]: sh(2) })).not.toBe(base);
		expect(deriveFrontierRoot({})).toMatch(/^dfr_/);
		expect(deriveFrontierRoot({})).not.toBe(base);
	});

	// The pre-image is length-framed: without framing, a single key smuggling
	// the "key|value\nkey" delimiters collapses two structurally different
	// maps into one byte string — one signed root reading as two different
	// attested sets, the exact property a commitment must not have.
	it('a delimiter-smuggling key cannot collide with an honest frontier', () => {
		const honest = { [mid(1)]: sh(1), [mid(2)]: sh(2) };
		const forged = { [`${mid(1)}|${sh(1)}\n${mid(2)}`]: sh(2) };
		expect(deriveFrontierRoot(forged)).not.toBe(deriveFrontierRoot(honest));
	});
});

describe('view tree (Invariants 3, 5, 6, 7)', () => {
	it('same state gives the same root regardless of key insertion order', () => {
		const entries = state(20);
		const shuffled: typeof entries = {};
		for (const key of Object.keys(entries).reverse()) shuffled[key] = entries[key];
		expect(buildViewTree(shuffled).root).toBe(buildViewTree(entries).root);
	});

	it('empty, single and many states all produce distinct stable roots', () => {
		expect(buildViewTree({}).root).toMatch(/^dvr_/);
		expect(buildViewTree(state(1)).root).not.toBe(buildViewTree({}).root);
		expect(buildViewTree(state(2)).root).not.toBe(buildViewTree(state(1)).root);
	});

	// The trie sorts keys as strings and walks them as UTF-8 bytes; those
	// orders agree only on ASCII, so a non-ASCII key must die at the door
	// rather than feed buildBranch's divergence scan.
	it('rejects a non-ASCII key instead of building a wrong tree', () => {
		expect(() => buildViewTree({ 'dmsg_ключ': { signHash: sh(1), deleted: false } }))
			.toThrow(/not ASCII/);
	});

	it('changing one message version changes the root (Invariant 5)', () => {
		const before = buildViewTree(state(5)).root;
		const after = buildViewTree(state(5, { [mid(2)]: { signHash: sh(9), deleted: false } })).root;
		expect(after).not.toBe(before);
	});

	it('a late insert diffs as exactly that one key (Invariant 6)', () => {
		const old = buildViewTree(state(10));
		const withLate = state(10);
		withLate['dmsg_0000e8f0-aaaa-7bbb-8ccc-000000000000'] = { signHash: sh(7), deleted: false };
		const diff = diffViewTrees(old, buildViewTree(withLate));
		expect(diff.added).toEqual(['dmsg_0000e8f0-aaaa-7bbb-8ccc-000000000000']);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
	});

	it('diff of equal trees is empty, including both empty', () => {
		expect(diffViewTrees(buildViewTree(state(6)), buildViewTree(state(6))))
			.toEqual({ added: [], removed: [], changed: [] });
		expect(diffViewTrees(buildViewTree({}), buildViewTree({})))
			.toEqual({ added: [], removed: [], changed: [] });
	});

	it('diff reports edits and tombstones with both values', () => {
		const old = buildViewTree(state(4));
		const next = state(4, {
			[mid(1)]: { signHash: sh(8), deleted: false },
			[mid(3)]: { signHash: sh(9), deleted: true },
		});
		const diff = diffViewTrees(old, buildViewTree(next));
		expect(diff.changed).toHaveLength(2);
		const changes = classifyChanges(diff);
		expect(changes).toContainEqual({ type: 'MESSAGE_EDITED', messageId: mid(1), oldVersion: sh(1), newVersion: sh(8) });
		expect(changes).toContainEqual({ type: 'MESSAGE_DELETED', messageId: mid(3), oldVersion: sh(3), newVersion: sh(9) });
	});

	it('classifies restore and removal', () => {
		const old = buildViewTree({ [mid(1)]: { signHash: sh(1), deleted: true }, [mid(2)]: { signHash: sh(2), deleted: false } });
		const next = buildViewTree({ [mid(1)]: { signHash: sh(3), deleted: false } });
		const changes = classifyChanges(diffViewTrees(old, next));
		expect(changes).toContainEqual({ type: 'MESSAGE_RESTORED', messageId: mid(1), oldVersion: sh(1), newVersion: sh(3) });
		expect(changes).toContainEqual({ type: 'MESSAGE_REMOVED', messageId: mid(2) });
	});
});

describe('Merkle proof', () => {
	it('round-trips for every key and fails for tampered values', () => {
		const s = state(9);
		const tree = buildViewTree(s);
		for (const key of Object.keys(s)) {
			const proof = proveViewKey(tree, key);
			expect(proof, key).not.toBe(null);
			expect(verifyViewProof(tree.root, key, s[key], proof!)).toBe(true);
			expect(verifyViewProof(tree.root, key, { ...s[key], deleted: true }, proof!)).toBe(false);
		}
	});

	it('returns null for an absent key', () => {
		expect(proveViewKey(buildViewTree(state(3)), mid(99))).toBe(null);
	});

	// Same convention as the signature layer: malformed input is a false
	// verdict, not an exception in whatever UI called verify.
	it('returns false on malformed proof input instead of throwing', () => {
		const s = state(3);
		const tree = buildViewTree(s);
		const key = Object.keys(s)[0];
		const good = proveViewKey(tree, key)!;
		expect(verifyViewProof(tree.root, key, s[key], [{ ...good[0], sibling: '' }, ...good.slice(1)])).toBe(false);
		expect(verifyViewProof(tree.root, key, s[key], [{ ...good[0], sibling: 'zz'.repeat(64) }, ...good.slice(1)])).toBe(false);
		expect(verifyViewProof(tree.root, key, s[key], [{ ...good[0], sibling: good[0].sibling.slice(0, 127) }, ...good.slice(1)])).toBe(false);
		expect(verifyViewProof(tree.root, key, s[key], [{ ...good[0], side: 'up' as never }, ...good.slice(1)])).toBe(false);
	});
});

describe('checkpoint envelope (07 §"checkpoint")', () => {
	const part = {
		kind: 'checkpoint' as const,
		version: CHECKPOINT_VERSION,
		reducerVersion: REDUCER_VERSION,
		treeVersion: TREE_VERSION,
		frontierRoot: deriveFrontierRoot({ [mid(1)]: sh(1) }),
		viewRoot: buildViewTree(state(1)).root,
		frontier: { [mid(1)]: sh(1) },
		createdAt: 1788470000,
	};

	it('round-trips through the canonical codec', () => {
		expect(decodeContent(encodeContent([part]))).toEqual([part]);
	});

	it('rejects a malformed envelope and previews as a marker', () => {
		expect(() => decodeContent('{"checkpoint":[1,2]}')).toThrow(ContentDecodeError);
		expect(previewText([part])).toBe('🔏 checkpoint');
	});

	// The frontier feeds hash pre-images; entries outside the exact wire
	// grammar die at decode, never reach a root computation or a diff.
	it('rejects a frontier entry outside the wire grammar', () => {
		const evil = { ...part, frontier: { [`${mid(1)}|x`]: sh(1) } };
		expect(() => decodeContent(encodeContent([evil]))).toThrow(ContentDecodeError);
		const badValue = { ...part, frontier: { [mid(1)]: 'dms_short' } };
		expect(() => decodeContent(encodeContent([badValue]))).toThrow(ContentDecodeError);
	});
});
