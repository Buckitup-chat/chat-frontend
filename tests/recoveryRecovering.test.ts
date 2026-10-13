// Returns are checked against the root on chain, then combined with the
// nodes' releases into S (pq_recovery_shares § Returning). A real run's split.
import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, sharePartOf } from '@/lib/recovery/backupRun';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { assembleWrapKey, checkReturn, returnOf } from '@/lib/recovery/recovering';

const run = { ...prepareRun({
	deployment: 'x',
	owner: '0x' + '77'.repeat(20),
	guardians: [1, 2, 3, 4].map((n) => ({ userHash: 'u_' + String(n).repeat(128), metaAddress: metaKeysOf(new Uint8Array(32).fill(n)).metaAddress })),
	settings: defaultSettings(4, 3),
	nodes: ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` })),
	device: 'd',
	now: 1,
}), version: 2 };
const REF = 'eip155:1:0xc/0x' + 'ab'.repeat(32);
const CANDIDATE = '0x' + '5a'.repeat(20);
const root = hexToBytes(run.root);
const expected = { secretRef: REF, version: 2, round: 3, candidate: CANDIDATE };
const ret = (i: number, over = {}) => {
	const { kind: _k, ...share } = sharePartOf(run, i, REF, 1);
	return { ...returnOf(share, 3, CANDIDATE, 5), ...over };
};

describe('a returned share', () => {
	it('checks against the root for this round and candidate', () => {
		expect(checkReturn(ret(0), expected, root)).toMatchObject({ ok: true, index: 1 });
	});

	it('is set aside when it answers another round, device, version, or does not check', () => {
		expect(checkReturn(ret(0, { round: 2 }), expected, root)).toMatchObject({ ok: false, reason: /another recovery round/ });
		expect(checkReturn(ret(0, { candidate: '0x' + '11'.repeat(20) }), expected, root)).toMatchObject({ ok: false, reason: /another device/ });
		expect(checkReturn(ret(0, { version: 1 }), expected, root)).toMatchObject({ ok: false });
		const edited = ret(0);
		edited.shareB64 = edited.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
		expect(checkReturn(edited, expected, root)).toMatchObject({ ok: false });
	});
});

describe('putting S together', () => {
	it('takes the threshold of returns and of node releases', () => {
		const ok = [ret(1), ret(2), ret(3)].map((r) => checkReturn(r, expected, root)).filter((c): c is Extract<typeof c, { ok: true }> => c.ok);
		const s = assembleWrapKey(ok, run.nodeShares.slice(1).map((h) => h!));
		expect(Buffer.from(s).toString('hex')).toBe(run.wrapKey);
	});

	it('refuses to combine short of either threshold', () => {
		const ok = [ret(1), ret(2)].map((r) => checkReturn(r, expected, root)).filter((c): c is Extract<typeof c, { ok: true }> => c.ok);
		expect(() => assembleWrapKey(ok, run.nodeShares.map((h) => h!))).toThrow(/need 3 different shares/);
		const enough = [ret(0), ret(1), ret(2)].map((r) => checkReturn(r, expected, root)).filter((c): c is Extract<typeof c, { ok: true }> => c.ok);
		expect(() => assembleWrapKey(enough, [run.nodeShares[0]!, run.nodeShares[0]!])).toThrow(/node releases/);
	});
});
