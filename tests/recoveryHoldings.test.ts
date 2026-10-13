// A guardian keeping the shares they were sent, and the owner reading back
// where each stands (pq_recovery_shares § Holding, § Dying). The shares are a
// real run's; the chain is faked honestly from the slots that run registered.
import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf, sharePartOf } from '@/lib/recovery/backupRun';
import { classifyShare, conflictKey, holdingFor, holdingKey, judgeShare, reportFor, shouldDrop, type Holding, type KeepingContext } from '@/lib/recovery/holdings';

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
	const kept = { [holdingKey(OWNER, share)]: holding() };

	it('allows a second index of the same split, refuses changed bytes or another split at the same version', () => {
		const { kind: _k, ...spare } = sharePartOf(run, 1, `${NS}/${ID}`, 1);
		expect(classifyShare(OWNER, { messageId: 'dmsg_2', share: spare }, kept)).toEqual({ kind: 'new' });
		expect(classifyShare(OWNER, { messageId: 'dmsg_2', share: { ...share, shareB64: 'AAAA' } }, kept)).toMatchObject({ kind: 'conflict', reason: expect.stringMatching(/different contents/) });
		expect(classifyShare(OWNER, { messageId: 'dmsg_2', share: { ...share, splitId: '00'.repeat(16) } }, kept)).toMatchObject({ kind: 'conflict', reason: expect.stringMatching(/another split/) });
		// Another owner's split at that version is no conflict.
		expect(classifyShare('u_other', { messageId: 'dmsg_2', share: { ...share, splitId: '00'.repeat(16) } }, kept)).toEqual({ kind: 'new' });
		expect(holdingKey(OWNER, share)).toBe(`${OWNER}|${NS}/${ID}|1|${share.splitId}|1`);
	});

	it('treats as handled the same bytes again, a tombstone, or a refusal recorded', () => {
		expect(classifyShare(OWNER, { messageId: 'dmsg_9', share }, kept)).toBeNull();
		const gone = { [holdingKey(OWNER, share)]: holding({ state: 'given_back', share: { ...share, shareB64: '' } }) };
		expect(classifyShare(OWNER, { messageId: 'dmsg_9', share }, gone)).toBeNull();
		const other = { messageId: 'dmsg_2', share: { ...share, shareB64: 'AAAA' } };
		const refused = { ...kept, [conflictKey(OWNER, other)]: holding({ state: 'conflict', messageId: 'dmsg_2' }) };
		expect(classifyShare(OWNER, other, refused)).toBeNull();
		expect(holdingFor(OWNER, other, refused)?.key).toBe(conflictKey(OWNER, other));
		expect(holdingFor(OWNER, other, kept)).toBeNull();
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
	it('tells each change once, a refusal as unverified, nothing while pending', () => {
		expect(reportFor(holding())).toMatchObject({ kind: 'recovery_holding', state: 'stored', shareIndex: 1, version: 1, detail: '' });
		expect(reportFor(holding({ reported: 'stored' }))).toBeNull();
		expect(reportFor(holding({ state: 'pending' }))).toBeNull();
		expect(reportFor(holding({ state: 'unverified', detail: 'x' }))).toMatchObject({ state: 'unverified', detail: 'x' });
		expect(reportFor(holding({ state: 'conflict', detail: 'y' }))).toMatchObject({ state: 'unverified', detail: 'y' });
		expect(reportFor(holding({ state: 'conflict', detail: 'y', reported: 'unverified' }))).toBeNull();
	});
});
