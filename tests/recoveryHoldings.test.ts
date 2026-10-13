// A guardian keeping the shares they were sent, and the owner reading back
// where each stands (pq_recovery_shares § Holding, § Dying). The shares are a
// real run's; the chain is faked honestly from the slots that run registered.
import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf, sharePartOf } from '@/lib/recovery/backupRun';
import { conflictOf, holdingKey, holdingStatesOf, judgeShare, reportOf, shouldDrop, type Holding, type KeepingContext } from '@/lib/recovery/holdings';

const NS = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const ID = '0x' + 'ab'.repeat(32);
const OWNER = 'u_' + 'o'.repeat(128);
const guardians = [1, 2, 3].map((n) => ({ userHash: 'u_' + String(n).repeat(128), metaAddress: metaKeysOf(new Uint8Array(32).fill(n)).metaAddress }));
const nodes = ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` }));
const run = { ...prepareRun({ deployment: NS, owner: '0x' + '77'.repeat(20), guardians, settings: defaultSettings(3, 3), nodes, device: 'd', now: 1 }), version: 1 };
const slots = shareInputsOf(run).map((s) => hexToBytes(s.shareEncrypted.slice(2)));
const { kind: _kind, ...share } = sharePartOf(run, 0, `${NS}/${ID}`, 1);

const ctx = (over: Partial<KeepingContext> = {}): KeepingContext => ({
	reachable: (ns) => ns === NS,
	consented: () => true,
	readSecret: async () => ({ version: 1, revoked: false }),
	slotsAt: async () => slots,
	...over,
});

describe('judging a share received', () => {
	it('stores one that checks against the root on chain', async () => {
		expect(await judgeShare(OWNER, share, ctx())).toEqual({ state: 'stored', detail: '' });
	});

	it('keeps but reports one it cannot place, did not agree to, or that does not check', async () => {
		expect(await judgeShare(OWNER, share, ctx({ reachable: () => false }))).toMatchObject({ state: 'unreachable' });
		expect(await judgeShare(OWNER, share, ctx({ consented: () => false }))).toMatchObject({ state: 'unrequested' });
		const edited = { ...share, shareB64: share.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
		expect(await judgeShare(OWNER, edited, ctx())).toMatchObject({ state: 'unverified' });
		expect(await judgeShare(OWNER, share, ctx({ slotsAt: async () => slots.slice(1) }))).toMatchObject({ state: 'unverified' });
	});

	it('waits for a version the chain does not show yet, and drops one that is revoked', async () => {
		expect(await judgeShare(OWNER, share, ctx({ readSecret: async () => null }))).toMatchObject({ state: 'pending' });
		expect(await judgeShare(OWNER, { ...share, version: 2 }, ctx())).toMatchObject({ state: 'pending' });
		expect(await judgeShare(OWNER, share, ctx({ slotsAt: async () => [] }))).toMatchObject({ state: 'pending' });
		expect(await judgeShare(OWNER, share, ctx({ readSecret: async () => ({ version: 1, revoked: true }) }))).toMatchObject({ state: 'dropped' });
	});
});

const holding = (over: Partial<Holding> = {}): Holding => ({ owner: OWNER, share, messageId: 'dmsg_1', state: 'stored', detail: '', updatedAt: 1, ...over });

describe('keeping several shares', () => {
	it('allows a second index of the same split, refuses changed bytes or another split at the same version', () => {
		const { kind: _k, ...spare } = sharePartOf(run, 1, `${NS}/${ID}`, 1);
		expect(conflictOf(spare, [holding()])).toBeNull();
		expect(conflictOf({ ...share, shareB64: 'AAAA' }, [holding()])).toMatch(/different contents/);
		expect(conflictOf({ ...share, splitId: '00'.repeat(16) }, [holding()])).toMatch(/another split/);
		expect(holdingKey(OWNER, share)).toBe(`${OWNER}|${NS}/${ID}|1|${share.splitId}|1`);
	});
});

describe('dropping a share', () => {
	const dying = (version: number, opts: { revoked?: boolean; mine?: boolean | null } = {}) => ({
		readSecret: async () => ({ version, revoked: !!opts.revoked }),
		addressedToMe: async () => (opts.mine === undefined ? true : opts.mine),
	});

	it('drops when revoked, never on the version bump alone', async () => {
		expect(await shouldDrop(holding(), [holding()], dying(1, { revoked: true }))).toMatch(/revoked/);
		expect(await shouldDrop(holding(), [holding()], dying(2))).toBeNull();
		expect(await shouldDrop(holding(), [holding()], dying(2, { mine: null }))).toBeNull();
	});

	it('drops once the replacement is held, or the new version has no slot for this guardian', async () => {
		const replacement = holding({ share: { ...share, version: 2 } });
		expect(await shouldDrop(holding(), [holding(), replacement], dying(2))).toMatch(/newer version/);
		expect(await shouldDrop(holding(), [holding()], dying(2, { mine: false }))).toMatch(/no longer lists this guardian/);
	});
});

describe('telling the owner', () => {
	it('tells each change once', () => {
		expect(reportOf(holding())).toMatchObject({ kind: 'recovery_holding', state: 'stored', shareIndex: 1, version: 1 });
		expect(reportOf(holding({ reported: 'stored' }))).toBeNull();
		expect(reportOf(holding({ state: 'pending' }))).toBeNull();
		expect(reportOf(holding({ state: 'unverified', detail: 'x' }))).toMatchObject({ state: 'unverified', detail: 'x' });
	});

	it('the owner reads only the guardian’s own word about the share they were sent, latest last', () => {
		const sent = { [guardians[0].userHash]: { secretRef: share.secretRef, version: 1, splitId: share.splitId, shareIndex: 1 } };
		const word = (state: string, over = {}) => ({ kind: 'recovery_holding', secretRef: share.secretRef, version: 1, splitId: share.splitId, shareIndex: 1, state, detail: '', ...over });
		const msgs = [
			{ senderHash: guardians[0].userHash, parts: [word('stored')] },
			{ senderHash: guardians[1].userHash, parts: [word('given_back')] }, // not the guardian it went to
			{ senderHash: guardians[0].userHash, parts: [word('stored', { shareIndex: 2 })] }, // another share
			{ senderHash: guardians[0].userHash, parts: [word('given_back')] },
			{ senderHash: guardians[0].userHash, parts: [word('whatever')] },
		];
		expect(holdingStatesOf(msgs, sent)).toEqual({ [guardians[0].userHash]: 'given_back' });
	});
});
