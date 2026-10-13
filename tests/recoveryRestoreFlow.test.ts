// A recovery as the temporary account lives it (pq_recovery_shares
// § Returning): it answers a guardian's request with a binding, follows the
// round for its candidate, judges each return against the version's root, asks
// the nodes only once it may decrypt — with its candidate key — and starts
// over with a fresh key after the window closes. The world keeps the contract
// of each party (tests/helpers/recoveryWorld).
import { describe, it, expect, beforeEach } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import type { RecoveryBindingPart } from '@/lib/pq/content';
import { requestRelease } from '@/lib/recovery/nodeClient';
import { returnOf } from '@/lib/recovery/recovering';
import { checkBinding, recoveryWords } from '@/lib/recovery/recoveryBinding';
import { candidateOf, helpRequestText } from '@/lib/recovery/restoring';
import { newMemo, newProgress, restarted, restorePass, wrapKeyFrom, type RestoreDeps, type RestoreProgress, type RestoreMemo } from '@/lib/recovery/restoreFlow';
import { NAMESPACE, hashOf, makeWorld, type World } from './helpers/recoveryWorld';

const TEMP = hashOf('e');

let w: World;
let progress: RestoreProgress;
let memo: RestoreMemo;
let saves: RestoreProgress[];
const deps = (): RestoreDeps => ({
	namespace: NAMESPACE,
	peersWhoWrote: async () => w.wrote(TEMP),
	readPeer: async (peer) => w.inbox(TEMP, peer, ['text', 'recovery_share_return']),
	sendBinding: async (peer, parts) => void w.send(TEMP, peer, parts),
	chain: w.chain,
	release: (node, id, key) => requestRelease(node, id, key, { fetch: w.nodeFetch }),
	save: async (p) => void saves.push(p),
	now: () => w.clock.now,
});
const pass = async () => {
	const out = await restorePass(progress, deps(), memo);
	progress = out.progress;
	return out.view;
};
const bindingsTo = (peer: string) => w.messages.filter((m) => m.from === TEMP && m.to === peer).flatMap((m) => m.parts) as RecoveryBindingPart[];
/** Guardian i, from their own keys, votes for `candidate` (opening the round first if `open`). */
const vote = (i: number, candidate: string, open = false) => {
	if (open) w.initiate(w.guardians[i].stealthAddress);
	w.approve(w.guardians[i].stealthAddress, candidate);
};
const giveBack = (i: number, candidate: string, over = {}) => w.send(w.guardians[i].userHash, TEMP, [{ ...returnOf(w.shareOf(i), Number(w.state.round), candidate, w.clock.now), ...over }]);

beforeEach(() => {
	w = makeWorld();
	progress = newProgress(TEMP, w.clock.now);
	memo = newMemo();
	saves = [];
});

describe('the temporary account', () => {
	it('answers each guardian\'s request once per candidate, with a binding they can check, and shows the words', async () => {
		expect((await pass()).secretRef).toBeNull();
		const g = w.guardians[0].userHash;
		w.send(g, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		const view = await pass();
		const candidate = candidateOf(progress.candidateKey);
		expect(view.secretRef).toBe(w.secretRef);
		expect(view.words).toEqual(recoveryWords(w.secretRef, candidate, TEMP));
		const [binding] = bindingsTo(g);
		expect(checkBinding(binding, { secretRef: w.secretRef, dialogPeerUserHash: TEMP })).toBe(candidate);
		expect(saves.at(-1)!.answered).toEqual({ [`${g}|${w.secretRef}`]: candidate });
		await pass();
		expect(bindingsTo(g)).toHaveLength(1);
		expect(view.round).toMatchObject({ phase: 'none' });
	});

	it('follows the round to its window and puts S together from two returns and two node releases', async () => {
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const candidate = candidateOf(progress.candidateKey);
		vote(0, candidate, true);
		let view = await pass();
		expect(view.round).toMatchObject({ phase: 'voting', quorum: 2 });
		expect(view.approvals).toBe(1);
		vote(1, candidate);
		view = await pass();
		expect(view.round).toMatchObject({ phase: 'timelock', executeAfter: w.clock.now + 600, expiresAt: w.clock.now + 600 + 3600 });

		w.clock.now += 601;
		giveBack(0, candidate);
		giveBack(1, candidate);
		view = await pass();
		expect(view.round!.phase).toBe('window');
		expect(view.returns).toMatchObject({ distinct: 2, threshold: 2, setAside: [] });
		// The node set is the verified shares': asked in order until the threshold, by the candidate.
		expect(w.nodeCalls).toEqual([
			{ node: w.nodes[0].id, recipient: candidate },
			{ node: w.nodes[1].id, recipient: candidate },
		]);
		expect(view.nodes.map((n) => n.state)).toEqual(['released', 'released', 'waiting']);
		expect(view.ready).toBe(true);
		expect(bytesToHex(wrapKeyFrom(view, memo))).toBe(w.run.wrapKey);
		// Nothing is asked again once enough came back.
		await pass();
		expect(w.nodeCalls).toHaveLength(2);
	});

	it('asks no node before the window, and none for a device the round did not elect', async () => {
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const candidate = candidateOf(progress.candidateKey);
		vote(0, candidate, true);
		vote(1, candidate);
		// A guardian who sends early: the share is judged, the nodes wait for the window.
		giveBack(0, candidate);
		let view = await pass();
		expect(view.round!.phase).toBe('timelock');
		expect(view.returns!.distinct).toBe(1);
		expect(w.nodeCalls).toEqual([]);

		// Another device was elected: elsewhere, nothing asked, and a restart is offered.
		w.cancel();
		w.initiate(w.guardians[2].stealthAddress);
		vote(1, '0x' + '11'.repeat(20));
		vote(2, '0x' + '11'.repeat(20));
		w.clock.now += 601;
		view = await pass();
		expect(view.round!.phase).toBe('elsewhere');
		expect(w.nodeCalls).toEqual([]);
	});

	it('reads a version\'s guardians and root once, and an approval once it is recorded', async () => {
		const calls = { guardiansAt: 0, shareAt: 0, hasApproved: 0 };
		const counted = { ...w.chain };
		for (const k of Object.keys(calls) as (keyof typeof calls)[]) {
			const real = (w.chain as any)[k];
			(counted as any)[k] = (...args: unknown[]) => (calls[k]++, real(...args));
		}
		const run = async () => (progress = (await restorePass(progress, { ...deps(), chain: counted }, memo)).progress);
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await run();
		vote(0, candidateOf(progress.candidateKey), true);
		await run();
		await run();
		await run();
		expect(calls.guardiansAt).toBe(1);
		expect(calls.shareAt).toBe(w.guardians.length);
		// Every guardian on the first pass in voting, then only those not yet seen approving.
		expect(calls.hasApproved).toBe(w.guardians.length + 2 * (w.guardians.length - 1));
	});

	it('asks the nodes again for another backup, though the node ids and the candidate are the same', async () => {
		const toWindow = async () => {
			const candidate = candidateOf(progress.candidateKey);
			vote(0, candidate, true);
			vote(1, candidate);
			w.clock.now += 601;
			giveBack(0, candidate);
			giveBack(1, candidate);
			return pass();
		};
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		expect((await toWindow()).ready).toBe(true);

		// Another backup, on nodes with the same ids: the first one's releases are not its.
		const before = w;
		w = makeWorld();
		w.clock.now = before.clock.now;
		for (const g of w.guardians) w.send(g.userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const view = await toWindow();
		expect(view.secretRef).toBe(w.secretRef);
		expect(w.nodeCalls).toHaveLength(2);
		expect(bytesToHex(wrapKeyFrom(view, memo))).toBe(w.run.wrapKey);
	});

	it('names the sender of a return that does not check, and does not count it', async () => {
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const candidate = candidateOf(progress.candidateKey);
		vote(0, candidate, true);
		vote(1, candidate);
		w.clock.now += 601;
		giveBack(0, candidate);
		const edited = returnOf(w.shareOf(2), Number(w.state.round), candidate, w.clock.now);
		edited.shareB64 = edited.shareB64.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
		w.send(w.guardians[2].userHash, TEMP, [edited]);
		giveBack(1, candidate, { round: 99 });
		const view = await pass();
		expect(view.returns!.distinct).toBe(1);
		expect(view.returns!.setAside.map((r) => r.sender).sort()).toEqual([w.guardians[1].userHash, w.guardians[2].userHash].sort());
		expect(view.ready).toBe(false);
	});

	it('tells a node holding another version from one that released, and does not combine its share', async () => {
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const candidate = candidateOf(progress.candidateKey);
		vote(0, candidate, true);
		vote(1, candidate);
		w.clock.now += 601;
		giveBack(0, candidate);
		giveBack(1, candidate);
		w.nodeVersion.set(w.nodes[0].id, 7);
		const view = await pass();
		expect(view.nodes.map((n) => n.state)).toEqual(['failed', 'released', 'released']);
		expect(view.nodes[0].detail).toMatch(/version 7/);
		expect(bytesToHex(wrapKeyFrom(view, memo))).toBe(w.run.wrapKey);
	});

	it('after a veto or an expired window starts over with a fresh key: every guardian is answered again, old returns no longer count', async () => {
		const g = w.guardians[0].userHash;
		w.send(g, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		await pass();
		const first = candidateOf(progress.candidateKey);
		vote(0, first, true);
		await pass();
		w.cancel();
		expect((await pass()).round!.phase).toBe('stopped');

		w.initiate(w.guardians[1].stealthAddress);
		vote(0, first);
		vote(1, first);
		w.clock.now += 601;
		giveBack(0, first);
		w.clock.now += 3600;
		expect((await pass()).round!.phase).toBe('expired');

		progress = restarted(progress);
		const second = candidateOf(progress.candidateKey);
		expect(second).not.toBe(first);
		const view = await pass();
		expect(bindingsTo(g).map((b) => b.candidate)).toEqual([first, second]);
		expect(view.words).toEqual(recoveryWords(w.secretRef, second, TEMP));
		expect(view.returns!.distinct).toBe(0);
		expect(view.returns!.setAside).toEqual([expect.objectContaining({ sender: g })]);
	});

	it('follows the backup most guardians asked about, and says when it is on a network this app does not reach', async () => {
		const stranger = hashOf('f');
		w.send(stranger, TEMP, [{ kind: 'text', text: helpRequestText(`eip155:1:0x${'12'.repeat(20)}/0x${'34'.repeat(32)}`) }]);
		let view = await pass();
		expect(view.problem).toMatch(/network this app does not reach/);
		w.send(w.guardians[0].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		w.send(w.guardians[1].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
		view = await pass();
		expect(view.secretRef).toBe(w.secretRef);
		expect(view.problem).toBeNull();
		// The stranger was answered too: a binding for another secret gives nothing away.
		expect(bindingsTo(stranger)).toHaveLength(1);
	});
});
