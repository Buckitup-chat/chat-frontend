// The friends' half split among guardians, and the check a share passes before
// it is combined: any `threshold` distinct shares give the half back, and a
// share that is damaged, foreign, shifted between fields or repeated is named
// rather than combined into a wrong half.
import { describe, it, expect } from 'vitest';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
	ShareCheckError,
	checkShare,
	combineFriendsHalf,
	deliveryRecord,
	deliveryTag,
	leafOf,
	rootFromSlots,
	rootOf,
	splitFriendsHalf,
	type ShareToCheck,
} from '@/lib/recovery/shareSplit';
import { joinHalves, newWrapKey, splitIntoHalves } from '@/lib/pq/vaultEnvelope';
import type { NodeSet } from '@/lib/recovery/nodeSet';

const nodes: NodeSet = {
	threshold: 2,
	nodes: ['a', 'b', 'c'].map((c, i) => `n_${String(i).repeat(32)}@https://${c}.example/recovery/node`),
};

const half = () => randomBytes(32);
const asChecked = (split: ReturnType<typeof splitFriendsHalf>, index: number): ShareToCheck => ({
	splitId: split.splitId,
	threshold: split.threshold,
	total: split.total,
	index,
	share: split.shares[index - 1],
	proof: split.leaves,
	nodeSet: split.nodeSet,
});

describe('the wrap key in two halves', () => {
	it('gives S back from both, and neither half is S', () => {
		const s = newWrapKey();
		const { nodeHalf, friendsHalf } = splitIntoHalves(s);
		expect(joinHalves(nodeHalf, friendsHalf)).toEqual(s);
		expect(friendsHalf).not.toEqual(s);
		expect(nodeHalf).not.toEqual(s);
	});
});

describe('splitting the friends\' half', () => {
	it('any threshold of the shares, in any order, gives the half back', () => {
		const h = half();
		const split = splitFriendsHalf(h, 5, 3, nodes);
		expect(combineFriendsHalf([5, 2, 3].map((i) => ({ index: i, share: split.shares[i - 1] })), 3)).toEqual(h);
	});

	it('refuses a threshold of 1, a threshold above total, and more than 255 shares', () => {
		expect(() => splitFriendsHalf(half(), 3, 1, nodes)).toThrow(ShareCheckError);
		expect(() => splitFriendsHalf(half(), 2, 3, nodes)).toThrow(ShareCheckError);
		expect(() => splitFriendsHalf(half(), 256, 2, nodes)).toThrow(ShareCheckError);
	});

	it('keeps its own copy of the node set: the caller editing its list later changes nothing', () => {
		const mine = { threshold: nodes.threshold, nodes: [...nodes.nodes] };
		const split = splitFriendsHalf(half(), 4, 2, mine);
		mine.nodes.pop();
		expect(() => checkShare(asChecked(split, 1), split.root)).not.toThrow();
	});

	it('counts a share sent twice as one point', () => {
		const split = splitFriendsHalf(half(), 5, 3, nodes);
		const twice = [{ index: 1, share: split.shares[0] }, { index: 1, share: split.shares[0] }, { index: 2, share: split.shares[1] }];
		expect(() => combineFriendsHalf(twice, 3)).toThrow(/need 3 different shares, got 2/);
	});
});

describe('checking a share against its split', () => {
	it('passes every share of the split', () => {
		const split = splitFriendsHalf(half(), 4, 2, nodes);
		for (let i = 1; i <= 4; i++) expect(() => checkShare(asChecked(split, i), split.root)).not.toThrow();
	});

	it('names a damaged share, and a share of another split', () => {
		const split = splitFriendsHalf(half(), 4, 2, nodes);
		const damaged = split.shares[1].slice();
		damaged[damaged.length - 1] ^= 1;
		expect(() => checkShare({ ...asChecked(split, 2), share: damaged }, split.root)).toThrow(/does not match its leaf/);
		const other = splitFriendsHalf(half(), 4, 2, nodes);
		expect(() => checkShare(asChecked(other, 2), split.root)).toThrow(/do not hash to the split's root/);
	});

	it('refuses bytes moved between fields: the share\'s header shifted into the split id', () => {
		// The leaf hashes split_id || u8(i) || share; without length checks these would hash alike.
		const split = splitFriendsHalf(half(), 4, 2, nodes);
		const s = asChecked(split, 2);
		const shifted = { ...s, splitId: s.splitId + '0208', share: s.share.slice(2) };
		expect(() => checkShare(shifted, split.root)).toThrow(ShareCheckError);
	});

	it('refuses a share claiming another index, a short proof, and a threshold the root was not made with', () => {
		const split = splitFriendsHalf(half(), 4, 2, nodes);
		expect(() => checkShare({ ...asChecked(split, 2), index: 3 }, split.root)).toThrow(/not share number 3/);
		expect(() => checkShare({ ...asChecked(split, 2), proof: split.leaves.slice(0, 3) }, split.root)).toThrow(/one 64-byte leaf per share/);
		// A lying threshold would make the recovering client combine too early; the root binds it.
		expect(() => checkShare({ ...asChecked(split, 2), threshold: 3 }, split.root)).toThrow(/root/);
	});

	it('refuses a share whose node set was rewritten, missing or malformed: the root binds the set', () => {
		// A guardian pointing the recovering client at nodes of their own fails here, before any node is asked.
		const split = splitFriendsHalf(half(), 4, 2, nodes);
		const rewritten = { ...nodes, nodes: [nodes.nodes[0], nodes.nodes[1], 'n_' + 'f'.repeat(32) + '@https://evil.example/recovery/node'] };
		expect(() => checkShare({ ...asChecked(split, 2), nodeSet: rewritten }, split.root)).toThrow(/do not hash to the split's root/);
		expect(() => checkShare({ ...asChecked(split, 2), nodeSet: { ...nodes, threshold: 3 } }, split.root)).toThrow(/root/);
		expect(() => checkShare({ ...asChecked(split, 2), nodeSet: null }, split.root)).toThrow(/names no node set/);
		expect(() => checkShare({ ...asChecked(split, 2), nodeSet: { ...nodes, threshold: 1 } }, split.root)).toThrow(/not well formed/);
	});
});

describe('the root on chain', () => {
	it('is found in the one 65-byte record among a version\'s slots, wherever it sits', () => {
		const split = splitFriendsHalf(half(), 3, 2, nodes);
		const slots = [deliveryTag(), deliveryRecord(split.root), deliveryTag()];
		expect(rootFromSlots(slots)).toEqual(split.root);
	});

	it('is not found in ECIES ciphertexts, however their first byte falls', () => {
		const ciphertext = randomBytes(97);
		ciphertext[0] = 0x01;
		expect(rootFromSlots([ciphertext, deliveryTag()])).toBeNull();
	});
});

describe('the derivations, pinned', () => {
	// Computed outside this module from the spec's definitions (pq_recovery_shares
	// §Re-issuing): shares issued by one build are checked by another, years
	// later, so a changed tag, field order or encoding must fail here first.
	const splitId = '00112233445566778899aabbccddeeff';
	const share = (i: number) => Uint8Array.of(8, i, ...new Uint8Array(4).fill(0x10 + i));

	it('hashes a leaf and a root to the same bytes as the spec', () => {
		const leaves = [1, 2, 3].map((i) => leafOf(splitId, i, share(i)));
		expect(bytesToHex(leaves[0])).toBe(
			'b8ca3a786c3cee10d8f33961fe43ec6cf94932ec2a91e1f372b87a636149f8a2dcde8570024b243bd0d455dcc39f486296a004fc61e1e5e7bd61d5abb16cf26e',
		);
		expect(bytesToHex(rootOf(2, 3, leaves, nodes))).toBe(
			'cb90b382cf61ee742909f601954dba94de4b7e957b3ca330b992a8522fdd84564407da2116403ea904b8278438b8abebbb7b6092899e226e7f3ec26987b3ff18',
		);
	});

	it('will not put a root of another length on chain', () => {
		expect(() => deliveryRecord(new Uint8Array(32))).toThrow(/64 bytes/);
	});
});
