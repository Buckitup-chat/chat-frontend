// The guardian's decisions (pq_recovery_shares § Returning): which binding
// counts, what to do about the round, and the send gate — this guardian's own
// vote, never the round's outcome alone.
import { describe, it, expect } from 'vitest';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { latestBinding, nextCheckIn, roundMove, sendGate } from '@/lib/recovery/helping';
import { bindingFor, candidateOf } from '@/lib/recovery/restoring';
import type { SecretState } from '@/lib/recovery/chain';

const REF = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7/0x' + 'ab'.repeat(32);
const TEMP = 'u_' + 'c'.repeat(128);
const KEY1 = '0x' + '11'.repeat(32);
const KEY2 = '0x' + '22'.repeat(32);
const text = (t: string) => ({ kind: 'text' as const, text: t });

describe('the binding the guardian acts on', () => {
	it('is the newest for the secret asked about, checked against the dialog peer', () => {
		const messages = [
			{ messageId: 'dmsg_1', parts: [bindingFor(KEY1, REF, TEMP)] },
			{ messageId: 'dmsg_2', parts: [text('hi')] },
			{ messageId: 'dmsg_3', parts: [bindingFor(KEY2, REF, TEMP)] },
			{ messageId: 'dmsg_4', parts: [bindingFor(KEY1, REF.replace('ab', 'cd'), TEMP)] },
		];
		expect(latestBinding(messages, { secretRef: REF, peer: TEMP })).toMatchObject({ ok: true, candidate: candidateOf(KEY2), messageId: 'dmsg_3' });
		expect(latestBinding(messages.slice(1, 2), { secretRef: REF, peer: TEMP })).toBeNull();
	});

	it('is refused when it names another account or is not signed by its candidate', () => {
		const forged = { ...bindingFor(KEY1, REF, TEMP), candidate: candidateOf(KEY2) };
		expect(latestBinding([{ messageId: 'dmsg_1', parts: [forged] }], { secretRef: REF, peer: TEMP })).toMatchObject({ ok: false, reason: /not signed by the candidate/ });
		expect(latestBinding([{ messageId: 'dmsg_1', parts: [bindingFor(KEY1, REF, TEMP)] }], { secretRef: REF, peer: 'u_' + 'd'.repeat(128) })).toMatchObject({
			ok: false,
			reason: /another account/,
		});
	});
});

describe('the round', () => {
	it('is opened when none is, voted in while voting, and left once quorum was reached without this vote', () => {
		expect(roundMove(RoundState.None, false)).toBe('initiate');
		expect(roundMove(RoundState.Expired, false)).toBe('initiate');
		expect(roundMove(RoundState.Voting, false)).toBe('approve');
		expect(roundMove(RoundState.TimeLock, false)).toBe('closed');
		expect(roundMove(RoundState.Window, false)).toBe('closed');
		expect(roundMove(RoundState.Voting, true)).toBe('approved');
		expect(roundMove(RoundState.Window, true)).toBe('approved');
		// An approval left from a vetoed or expired round does not stand for a new one.
		expect(roundMove(RoundState.None, true)).toBe('initiate');
		expect(roundMove(RoundState.Expired, true)).toBe('initiate');
	});
});

describe('the send gate', () => {
	const me = candidateOf(KEY1);
	const approved = { candidate: me, round: 3, heldVersion: 2 };
	const secret = (over: Partial<SecretState> = {}): SecretState => ({
		owner: '0x' + '77'.repeat(20),
		revoked: false,
		label: 'bu',
		threshold: 2n,
		recoveryDelay: 600n,
		recoveryWindow: 3600n,
		recoveryRound: 3n,
		recoveryActive: true,
		recoveryRecipient: me.toUpperCase().replace('0X', '0x'),
		executeAfter: 1000n,
		version: 2n,
		...over,
	});
	const gate = (state: RoundState, over: Partial<SecretState> = {}, rest: { hasApproved?: boolean; now?: number } = {}) =>
		sendGate({ secret: secret(over), state, hasApproved: rest.hasApproved ?? true, approved, now: rest.now ?? 2000 });

	it('opens in the window of the round voted in, for the candidate approved, at the current version', () => {
		expect(gate(RoundState.Window)).toEqual({ kind: 'send' });
	});

	it('waits while voting and through the timelock — the owner\'s veto still protects the share', () => {
		expect(gate(RoundState.Voting, { recoveryRecipient: '0x' + '00'.repeat(20), executeAfter: 0n })).toEqual({ kind: 'wait', until: null });
		expect(gate(RoundState.TimeLock, {}, { now: 500 })).toEqual({ kind: 'wait', until: 1000 });
	});

	it('stops for another device, a veto, a later round, an expired window, a missing vote or an old share', () => {
		const stops: [ReturnType<typeof gate>, RegExp][] = [
			[gate(RoundState.Window, { recoveryRecipient: '0x' + '11'.repeat(20) }), /another device/],
			[gate(RoundState.TimeLock, { recoveryRecipient: '0x' + '11'.repeat(20) }), /another device/],
			[gate(RoundState.None, { recoveryActive: false }), /stopped/],
			[gate(RoundState.Voting, { recoveryRound: 4n }), /later recovery/],
			[gate(RoundState.Window, { recoveryRound: 4n }), /later recovery/],
			[gate(RoundState.Expired), /ran out of time/],
			[gate(RoundState.Window, {}, { now: 4600 }), /ran out of time/],
			[gate(RoundState.Window, {}, { hasApproved: false }), /approval is not on the network/],
			[gate(RoundState.Window, { version: 3n }), /earlier version/],
			[gate(RoundState.Window, { revoked: true }), /revoked/],
			[gate(RoundState.Window, { owner: me }), /owner/],
		];
		for (const [g, reason] of stops) expect(g).toMatchObject({ kind: 'stop', reason });
		expect(sendGate({ secret: null, state: RoundState.None, hasApproved: true, approved, now: 0 })).toMatchObject({ kind: 'stop' });
	});

	it('is read again about once a block near the window, and once a minute otherwise', () => {
		expect(nextCheckIn({ kind: 'wait', until: 1000 }, 950, 12)).toBe(12);
		expect(nextCheckIn({ kind: 'wait', until: 1000 }, 999, 2)).toBe(2);
		expect(nextCheckIn({ kind: 'wait', until: 10_000 }, 0, 12)).toBe(60);
		expect(nextCheckIn({ kind: 'wait', until: 1000 }, 850, 12)).toBe(30);
		expect(nextCheckIn({ kind: 'wait', until: null }, 0, 12)).toBe(60);
	});
});
