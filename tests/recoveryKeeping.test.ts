// A guardian keeping the shares their contacts send (pq_recovery_shares
// § Holding, § Dying): the copy in the guardian slot, the state told to the
// owner once, refusals, pending shares read again, drops and give-backs. The
// shares and the chain's slots are a real run's; the slot merges by key as
// storageIntent does, and the chain answers from what that run registered.
import { describe, it, expect, beforeEach } from 'vitest';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf, sharePartOf } from '@/lib/recovery/backupRun';
import { conflictKey, holdingKey, type Holdings, type ShareEnvelope } from '@/lib/recovery/holdings';
import { guardianChainReads, type GuardianChain } from '@/lib/recovery/chain';
import { consentedIn } from '@/lib/recovery/invitations';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import {
	anyUnhandled, giveBack, GiveBackError, receiveShares, secretsToCheck, sweepDue, sweepHoldings, type KeepingDeps,
} from '@/lib/recovery/keeping';
import type { RecoveryHoldingPart } from '@/lib/pq/content';
import type { GuardianAnswer } from '@/lib/recovery/inviteThread';

const NS = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const ID = '0x' + 'ab'.repeat(32);
const REF = `${NS}/${ID}`;
const OWNER = 'u_' + 'o'.repeat(128);
const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const guardians = seeds.map((seed, i) => ({ userHash: 'u_' + String(i + 1).repeat(128), metaAddress: metaKeysOf(seed).metaAddress }));
const nodes = ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.example/recovery/node` }));
const runAt = (version: number, gs = guardians) => ({
	...prepareRun({ deployment: NS, owner: '0x' + '77'.repeat(20), guardians: gs, settings: defaultSettings(gs.length, 3), nodes, device: 'd', now: 1 }),
	version,
});
const envelopeOf = (run: ReturnType<typeof runAt>, i: number): ShareEnvelope => {
	const { kind: _kind, ...share } = sharePartOf(run, i, REF, 1);
	return share;
};

const v1 = runAt(1);
const share = envelopeOf(v1, 0);
const KEY = holdingKey(OWNER, share);

// --- Fakes honouring the contract ----------------------------------------------

/** The chain: what each version registered, answered as RecoveryChain does. */
const makeChain = () => {
	const state = { version: 1, revoked: false, exists: true, down: false };
	const versions = new Map<number, ReturnType<typeof shareInputsOf>>([[1, shareInputsOf(v1)]]);
	const reads = { secret: 0, slots: 0 };
	const chain: GuardianChain = {
		readSecret: async () => {
			reads.secret += 1;
			if (state.down) throw new Error('the chain did not answer');
			return state.exists ? { version: BigInt(state.version), revoked: state.revoked } : null;
		},
		guardiansAt: async (_id, v) => {
			reads.slots += 1;
			if (state.down) throw new Error('the chain did not answer');
			return (versions.get(Number(v)) ?? []).map((s) => s.stealthAddress);
		},
		shareAt: async (_id, v, address) => {
			const s = versions.get(Number(v))!.find((x) => x.stealthAddress === address)!;
			return { ephemeralPubKey: s.ephemeralPubKey, shareEncrypted: s.shareEncrypted };
		},
	};
	return { chain, state, versions, reads };
};

let slot: Record<string, unknown>;
let sent: { owner: string; parts: RecoveryHoldingPart[] }[];
let failSend: boolean;
let answers: Record<string, GuardianAnswer>;
let chainFake: ReturnType<typeof makeChain>;
let seed: Uint8Array | null;

const holdings = (): Holdings => (slot.holdings ?? {}) as Holdings;

let saves: number;
const deps = (): KeepingDeps => {
	const reads = guardianChainReads(chainFake.chain, async () => (seed ? metaKeysOf(seed) : null));
	const keeping = { reachable: (ns: string) => ns === NS, consented: (o: string, ns: string) => consentedIn(answers, o, ns), readSecret: reads.readSecret, slotsAt: reads.slotsAt };
	const dying = { readSecret: reads.readSecret, addressedToMe: reads.addressedToMe };
	return {
		load: async () => structuredClone(holdings()),
		// The slot's keyed merge, as the materializer applies it.
		save: async (entries) => {
			saves += 1;
			slot = structuredClone(stripPatchDirectives(mergeJsonPatch(slot, { $keyed: ['holdings'], holdings: entries })));
			return structuredClone(holdings());
		},
		send: async (owner, parts) => {
			if (failSend) throw new Error('not captured');
			sent.push({ owner, parts });
		},
		keeping,
		dying,
		now: () => 1_700_000_000,
	};
};

beforeEach(() => {
	slot = { answers: {} };
	saves = 0;
	sent = [];
	failSend = false;
	answers = { i1: { owner: OWNER, deployment: NS, answer: 'accept', at: 10 } };
	chainFake = makeChain();
	seed = seeds[0];
});

const states = () => sent.map((s) => s.parts[0].state);

describe('receiving a share', () => {
	it('copies it into the slot, stores it once it checks, and tells the owner once', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(holdings()[KEY]).toMatchObject({ owner: OWNER, messageId: 'dmsg_1', state: 'stored', reported: 'stored' });
		expect(holdings()[KEY].share.shareB64).toBe(share.shareB64);
		expect(sent).toEqual([{ owner: OWNER, parts: [expect.objectContaining({ kind: 'recovery_holding', secretRef: REF, version: 1, shareIndex: 1, state: 'stored', detail: '' })] }]);

		// The dialog renders again, and the share is sent again in a later message (a re-issue).
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }, { messageId: 'dmsg_9', share }]);
		expect(states()).toEqual(['stored']);
		expect(anyUnhandled(OWNER, [{ messageId: 'dmsg_9', share }], holdings())).toBe(false);
	});

	it('keeps the copy when the chain does not answer, and tells nothing until it does', async () => {
		chainFake.state.down = true;
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(holdings()[KEY]).toMatchObject({ state: 'pending' });
		expect(holdings()[KEY].share.shareB64).toBe(share.shareB64);
		expect(sent).toEqual([]);
	});

	it('keeps a share edited in transit and reports it, never as stored', async () => {
		const edited = { ...share, shareB64: share.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share: edited }]);
		expect(holdings()[KEY]).toMatchObject({ state: 'unverified', reported: 'unverified' });
		expect(sent[0].parts[0]).toMatchObject({ state: 'unverified', detail: expect.any(String) });
		expect(sent[0].parts[0].detail).not.toBe('');
	});

	it('keeps a share it did not agree to and says so, a later decline withdrawing an acceptance', async () => {
		answers.i2 = { owner: OWNER, deployment: NS, answer: 'decline', at: 20 };
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(holdings()[KEY]).toMatchObject({ state: 'unrequested' });
		expect(holdings()[KEY].share.shareB64).toBe(share.shareB64);
		expect(states()).toEqual(['unrequested']);
	});

	it('keeps a second piece of the same split as a holding of its own', async () => {
		const spare = envelopeOf(v1, 1);
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }, { messageId: 'dmsg_2', share: spare }]);
		expect(holdings()[holdingKey(OWNER, spare)]).toMatchObject({ state: 'stored' });
		expect(states()).toEqual(['stored', 'stored']);
	});
});

describe('a share that disagrees with one kept', () => {
	it('is refused without its bytes, beside the one kept, and reported once as unverified', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		const other = { ...share, shareB64: envelopeOf(v1, 1).shareB64 };
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_2', share: other }]);
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_2', share: other }]);

		expect(holdings()[KEY]).toMatchObject({ state: 'stored', messageId: 'dmsg_1' });
		expect(holdings()[KEY].share.shareB64).toBe(share.shareB64);
		const refused = holdings()[conflictKey(OWNER, { messageId: 'dmsg_2', share: other })];
		expect(refused).toMatchObject({ state: 'conflict', detail: expect.stringMatching(/different contents/), reported: 'unverified' });
		expect(refused.share.shareB64).toBe('');
		expect(sent.map((s) => [s.parts[0].state, s.parts[0].detail])).toEqual([['stored', ''], ['unverified', 'this piece was already sent with different contents']]);
	});

	it('refuses another split at a version already held', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		const otherSplit = envelopeOf(runAt(1), 1);
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_2', share: otherSplit }]);
		expect(holdings()[holdingKey(OWNER, otherSplit)]).toBeUndefined();
		expect(holdings()[conflictKey(OWNER, { messageId: 'dmsg_2', share: otherSplit })]).toMatchObject({ state: 'conflict', detail: expect.stringMatching(/another split/) });
	});
});

describe('telling the owner', () => {
	it('tells a state whose report was not captured on the next pass, and only once', async () => {
		failSend = true;
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(holdings()[KEY]).toMatchObject({ state: 'stored' });
		expect(holdings()[KEY].reported).toBeUndefined();

		failSend = false;
		await sweepHoldings(deps());
		await sweepHoldings(deps());
		expect(states()).toEqual(['stored']);
		expect(holdings()[KEY].reported).toBe('stored');
	});
});

describe('the periodic pass', () => {
	it('judges a pending share again once the chain shows its version', async () => {
		chainFake.state.exists = false;
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'pending' });
		expect(sent).toEqual([]);

		chainFake.state.exists = true;
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'stored', reported: 'stored' });
		expect(states()).toEqual(['stored']);
	});

	it('drops a share at once when the secret is revoked, leaving no bytes', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		chainFake.state.revoked = true;
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'dropped', detail: 'the backup was revoked', reported: 'dropped' });
		expect(holdings()[KEY].share.shareB64).toBe('');
		expect(states()).toEqual(['stored', 'dropped']);
		// A tombstone is not a share received again.
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		expect(states()).toEqual(['stored', 'dropped']);
	});

	it('keeps a share through a reshare that still addresses this guardian, until the replacement is held', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		const v2 = runAt(2);
		chainFake.versions.set(2, shareInputsOf(v2));
		chainFake.state.version = 2;
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'stored' });

		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_5', share: envelopeOf(v2, 0) }]);
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'dropped', detail: 'a newer version replaced it' });
		expect(holdings()[holdingKey(OWNER, envelopeOf(v2, 0))]).toMatchObject({ state: 'stored' });
	});

	it('drops a share once the new version has no slot this guardian\'s viewing key recognises', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		chainFake.versions.set(2, shareInputsOf(runAt(2, guardians.slice(1))));
		chainFake.state.version = 2;
		seed = null;
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'stored' });

		seed = seeds[0];
		await sweepHoldings(deps());
		expect(holdings()[KEY]).toMatchObject({ state: 'dropped', detail: 'the backup no longer lists this guardian' });
	});

	it('leaves a share for a network this build cannot reach to the guardian', async () => {
		const elsewhere = { ...share, secretRef: `eip155:10:0x${'1'.repeat(40)}/${ID}` };
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share: elsewhere }]);
		const reads = chainFake.reads.secret;
		chainFake.state.revoked = true;
		await sweepHoldings(deps());
		expect(holdings()[holdingKey(OWNER, elsewhere)]).toMatchObject({ state: 'unreachable' });
		expect(chainFake.reads.secret).toBe(reads);
	});
});

describe('whether a sweep has anything to do', () => {
	it('asks the chain about kept shares on a reachable network, and is due only on a change, a pending share or an untold state', async () => {
		const spare = envelopeOf(v1, 1);
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }, { messageId: 'dmsg_2', share: spare }]);
		const reachable = (ns: string) => ns === NS;
		expect(secretsToCheck(holdings(), reachable)).toEqual([ID]);
		expect(secretsToCheck(holdings(), () => false)).toEqual([]);
		expect(sweepDue(holdings(), new Map([[ID, { version: 1, revoked: false }]]))).toBe(false);
		expect(sweepDue(holdings(), new Map())).toBe(false);
		expect(sweepDue(holdings(), new Map([[ID, { version: 2, revoked: false }]]))).toBe(true);
		expect(sweepDue(holdings(), new Map([[ID, { version: 1, revoked: true }]]))).toBe(true);
		expect(sweepDue({ ...holdings(), [KEY]: { ...holdings()[KEY], reported: undefined } }, new Map())).toBe(true);
		expect(sweepDue({ ...holdings(), [KEY]: { ...holdings()[KEY], state: 'pending' } }, new Map())).toBe(true);
	});

	it('writes every change of a pass in one patch, and every mark of what was told in one more', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }, { messageId: 'dmsg_2', share: envelopeOf(v1, 1) }]);
		expect(saves).toBe(3); // the copies, the judged states, the marks
		chainFake.state.revoked = true;
		saves = 0;
		await sweepHoldings(deps());
		expect(saves).toBe(2);
		expect(states()).toEqual(['stored', 'stored', 'dropped', 'dropped']);
	});

	it('takes secrets already read as read', async () => {
		const reads = guardianChainReads(chainFake.chain, async () => null, new Map([[ID, { version: 7, revoked: false }]]));
		expect(await reads.readSecret(ID)).toEqual({ version: 7, revoked: false });
		expect(chainFake.reads.secret).toBe(0);
		await expect(guardianChainReads(null, async () => null).readSecret(ID)).rejects.toThrow(/no network/);
	});
});

describe('giving a share back', () => {
	it('removes the bytes, keeps the record and tells the owner', async () => {
		await receiveShares(deps(), OWNER, [{ messageId: 'dmsg_1', share }]);
		await giveBack(deps(), KEY);
		expect(holdings()[KEY]).toMatchObject({ state: 'given_back', reported: 'given_back' });
		expect(holdings()[KEY].share.shareB64).toBe('');
		expect(holdings()[KEY].share.splitId).toBe(share.splitId);
		expect(states()).toEqual(['stored', 'given_back']);
		await expect(giveBack(deps(), KEY)).rejects.toBeInstanceOf(GiveBackError);
	});
});

describe('consent', () => {
	it('is the latest answer to that owner for that deployment', () => {
		const a = (answer: 'accept' | 'decline', at: number, over = {}): GuardianAnswer => ({ owner: OWNER, deployment: NS, answer, at, ...over });
		expect(consentedIn({ x: a('accept', 1) }, OWNER, NS)).toBe(true);
		expect(consentedIn({ x: a('accept', 1), y: a('decline', 2) }, OWNER, NS)).toBe(false);
		expect(consentedIn({ x: a('decline', 1), y: a('accept', 2) }, OWNER, NS)).toBe(true);
		expect(consentedIn({ x: a('accept', 1, { owner: 'u_other' }) }, OWNER, NS)).toBe(false);
		expect(consentedIn({ x: a('accept', 1, { deployment: 'eip155:10:0x1' }) }, OWNER, NS)).toBe(false);
		expect(consentedIn(undefined, OWNER, NS)).toBe(false);
	});
});
