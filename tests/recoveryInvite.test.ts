// A guardian's meta keys, the reply that carries them, and the node set a
// share names: the parts of the recovery wire that are not the share itself.
// The pinned values are computed outside these modules — noble's own HKDF,
// secp256k1 and keccak — from pq_recovery_shares § Inviting.
import { describe, it, expect } from 'vitest';
import {
	checkInviteReply,
	inviteProof,
	inviteStateOf,
	metaKeysOf,
	newInviteId,
	newMetaSeed,
	spendingKeyOf,
	type CheckedReply,
} from '@/lib/recovery/guardianInvite';
import { NodeSetError, checkNodeSet, nodeSetHash, parseNodeEntry } from '@/lib/recovery/nodeSet';
import { bytesToHex } from '@noble/hashes/utils';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const owner = 'u_' + 'a'.repeat(128);
const guardian = 'u_' + 'b'.repeat(128);
const inviteId = '00112233445566778899aabbccddeeff';

describe('the guardian meta keys', () => {
	it('come from the seed alone, pinned', () => {
		const keys = metaKeysOf(seed);
		expect(keys.spendingPrivateKey).toBe('0x072ffd2e3998e214ffc0afee948094b8cefdd08ad8ad4c8df7447456d975cc6d');
		expect(keys.viewingPrivateKey).toBe('0xa79e18756ef5ea4fa1f89d1b95a5c1c9821e8f057e06859279068f337d8ba6e3');
		expect(keys.metaAddress).toBe(
			'0x028fcd1bd4f1b308bb66cad03a1c760f70a6a89761de8d871009975d3d41a2125202efe9d49e120fcdfa6736992b9fd0cbb2cbfa93d147dcbef7a8e783563ae0cab7',
		);
	});

	it('are the same on every derivation, and differ between seeds', () => {
		const s = newMetaSeed();
		expect(metaKeysOf(s)).toEqual(metaKeysOf(Uint8Array.from(s)));
		expect(metaKeysOf(newMetaSeed()).metaAddress).not.toBe(metaKeysOf(s).metaAddress);
	});

	it('refuse a seed that is not 32 bytes', () => {
		expect(() => metaKeysOf(new Uint8Array(31))).toThrow(/32 bytes/);
	});

	it('read back from a meta-address only when both halves are curve points', () => {
		const { metaAddress } = metaKeysOf(seed);
		expect(spendingKeyOf(metaAddress)).toBe(metaAddress.slice(0, 68));
		expect(spendingKeyOf(metaAddress.slice(0, 68) + '02' + '00'.repeat(32))).toBeNull();
		expect(spendingKeyOf(metaAddress.toUpperCase())).toBeNull();
		expect(spendingKeyOf(metaAddress.slice(0, 130))).toBeNull();
	});
});

describe('a reply to an invitation', () => {
	const keys = metaKeysOf(seed);
	const accept = () => ({ inviteId, answer: 'accept', metaAddress: keys.metaAddress, proofB64: inviteProof(keys, inviteId, owner, guardian) });

	it('carries a proof by the spending key, pinned', () => {
		expect(accept().proofB64).toBe('Eb1KmHzBODnLJZgqUAXwnBQmYMoesv+fRAj0KzON2PQympMY/YLGNUXjyqrrG7pQb1NiWBp5PGrrAS3EIkVtqRw');
	});

	it('is an acceptance when the proof is by the meta-address\'s spending key', () => {
		expect(checkInviteReply(accept(), owner, guardian)).toEqual({ ok: true, answer: 'accept', metaAddress: keys.metaAddress });
	});

	it('is refused when it replays another guardian\'s meta-address, or names another invitation or pair', () => {
		// Every owner of a guardian has their meta-address; only the guardian can sign for it.
		const other = metaKeysOf(newMetaSeed());
		expect(checkInviteReply({ ...accept(), metaAddress: other.metaAddress }, owner, guardian)).toMatchObject({ ok: false });
		expect(checkInviteReply({ ...accept(), inviteId: 'ff'.repeat(16) }, owner, guardian)).toMatchObject({ ok: false });
		expect(checkInviteReply(accept(), owner, 'u_' + 'c'.repeat(128))).toMatchObject({ ok: false });
		expect(checkInviteReply({ ...accept(), proofB64: 'AAAA' }, owner, guardian)).toMatchObject({ ok: false });
	});

	it('is a decline whatever else it carries, and nothing when its answer is unknown', () => {
		expect(checkInviteReply({ inviteId, answer: 'decline', metaAddress: '', proofB64: '' }, owner, guardian)).toEqual({ ok: true, answer: 'decline' });
		expect(checkInviteReply({ ...accept(), answer: 'maybe' }, owner, guardian)).toMatchObject({ ok: false });
		expect(checkInviteReply({ ...accept(), inviteId: 'not hex' }, owner, guardian)).toMatchObject({ ok: false });
	});

	it('has fresh ids of 16 bytes', () => {
		expect(newInviteId()).toMatch(/^[0-9a-f]{32}$/);
		expect(newInviteId()).not.toBe(newInviteId());
	});
});

describe('an invitation\'s state', () => {
	const a: CheckedReply = { ok: true, answer: 'accept', metaAddress: '0x' + '02'.repeat(66) };
	const b: CheckedReply = { ok: true, answer: 'accept', metaAddress: '0x' + '03'.repeat(66) };
	const d: CheckedReply = { ok: true, answer: 'decline' };
	const junk: CheckedReply = { ok: false, reason: 'bad proof' };
	const orders = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

	it('is the same in every order of its replies', () => {
		const sets: CheckedReply[][] = [[a, junk], [a, d], [a, b], [a, a, junk]];
		for (const set of sets) {
			const states = orders(set).map((o) => JSON.stringify(inviteStateOf(o)));
			expect(new Set(states).size).toBe(1);
		}
	});

	it('is pending, accepted, withdrawn by any decline, and void on two different acceptances', () => {
		expect(inviteStateOf([])).toEqual({ state: 'pending' });
		expect(inviteStateOf([junk])).toEqual({ state: 'pending' });
		expect(inviteStateOf([a, a])).toEqual({ state: 'accepted', metaAddress: a.ok && a.answer === 'accept' ? a.metaAddress : '' });
		expect(inviteStateOf([a, d])).toEqual({ state: 'declined' });
		expect(inviteStateOf([a, b])).toEqual({ state: 'void' });
	});
});

describe('a node set', () => {
	const entry = (i: number, host = 'n.example') => `n_${String(i).repeat(32)}@https://${host}/recovery/node`;
	const nodes = [0, 1, 2].map((i) => entry(i, ['a', 'b', 'c'][i] + '.example'));

	it('hashes as pinned', () => {
		expect(bytesToHex(nodeSetHash({ threshold: 2, nodes }))).toBe(
			'42a9aa555cbfab3bee66a922dfa0b89ca90e7402ef307e192241317a09ad76a28e5b0daec320d132531c62bf6b27a1029bcd52a13be90ade4fe0f7c4baaf4fa3',
		);
	});

	it('binds its order and its threshold', () => {
		const h = bytesToHex(nodeSetHash({ threshold: 2, nodes }));
		expect(bytesToHex(nodeSetHash({ threshold: 2, nodes: [...nodes].reverse() }))).not.toBe(h);
		expect(bytesToHex(nodeSetHash({ threshold: 3, nodes }))).not.toBe(h);
	});

	it('refuses a threshold below 2 or above its size, a repeated node, and more than 16 nodes', () => {
		expect(() => checkNodeSet({ threshold: 1, nodes })).toThrow(NodeSetError);
		expect(() => checkNodeSet({ threshold: 4, nodes })).toThrow(NodeSetError);
		expect(() => checkNodeSet({ threshold: 2, nodes: [nodes[0], nodes[0], nodes[1]] })).toThrow(/twice/);
		const many = Array.from({ length: 17 }, (_, i) => `n_${i.toString(16).padStart(32, '0')}@https://n${i}.example/x`);
		expect(() => checkNodeSet({ threshold: 2, nodes: many })).toThrow(NodeSetError);
	});

	it('refuses an entry that is not a key-derived id at an https URL without credentials, query or fragment', () => {
		for (const bad of [
			'node-a@https://a.example/x',
			`n_${'0'.repeat(32)}@http://a.example/x`,
			`n_${'0'.repeat(32)}@https://user@a.example/x`,
			`n_${'0'.repeat(32)}`,
			`n_${'0'.repeat(32)}@not a url`,
			// Not the canonical serialization of the URL: case, whitespace, a missing slash, a backslash.
			`n_${'0'.repeat(32)}@HTTPS://A.EXAMPLE/x`,
			`n_${'0'.repeat(32)}@ https://a.example/x`,
			`n_${'0'.repeat(32)}@https://a.example`,
			`n_${'0'.repeat(32)}@https:a.example/x`,
			`n_${'0'.repeat(32)}@https://a.example\\x`,
			// A route appended to it would land in the query or the fragment.
			`n_${'0'.repeat(32)}@https://a.example/x?q=1`,
			`n_${'0'.repeat(32)}@https://a.example/x#f`,
		]) {
			expect(() => parseNodeEntry(bad)).toThrow(NodeSetError);
		}
		expect(parseNodeEntry(nodes[0])).toEqual({ id: 'n_' + '0'.repeat(32), url: 'https://a.example/recovery/node' });
		expect(parseNodeEntry(`n_${'0'.repeat(32)}@https://a.example/@x`).url).toBe('https://a.example/@x');
		// The hash writes each entry's length in two bytes; a longer one would hash as another.
		expect(() => parseNodeEntry(`n_${'0'.repeat(32)}@https://a.example/${'x'.repeat(0x10000)}`)).toThrow(/length field/);
	});
});
