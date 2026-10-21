// A live recovery round on the owner's own secret, as the app warns about it
// (plan § 7.4): over every screen until it ends or the owner says it is theirs.
import { describe, it, expect } from 'vitest';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { ackOf, acknowledged, alertOf, alertText } from '@/lib/recovery/rounds';
import type { SecretState } from '@/lib/recovery/chain';

const ID = '0x' + 'ab'.repeat(32);
const secret = (over: Partial<SecretState> = {}): SecretState => ({
	owner: '0x' + '11'.repeat(20),
	revoked: false,
	label: 'bu-x',
	threshold: 2n,
	recoveryDelay: 3n * 86400n,
	recoveryWindow: 7n * 86400n,
	recoveryRound: 4n,
	recoveryActive: true,
	recoveryRecipient: '0x' + '00'.repeat(20),
	executeAfter: 0n,
	version: 1n,
	...over,
});

describe('a round on the owner’s secret', () => {
	it('alerts while voting, in the timelock and in the window', () => {
		expect(alertOf(ID, secret(), RoundState.Voting)).toEqual({ secretId: ID, round: 4, phase: 'voting', executeAfter: 0, expiresAt: 0, recipient: null });
		const elected = secret({ executeAfter: 1_000_000n, recoveryRecipient: '0x' + '22'.repeat(20) });
		expect(alertOf(ID, elected, RoundState.TimeLock)).toMatchObject({ phase: 'timelock', executeAfter: 1_000_000, expiresAt: 1_000_000 + 7 * 86400, recipient: '0x' + '22'.repeat(20) });
		expect(alertOf(ID, elected, RoundState.Window)).toMatchObject({ phase: 'window' });
	});

	it('is quiet with no round, an expired one, a revoked secret or none at all', () => {
		expect(alertOf(ID, secret(), RoundState.None)).toBeNull();
		expect(alertOf(ID, secret(), RoundState.Expired)).toBeNull();
		expect(alertOf(ID, secret({ revoked: true }), RoundState.Voting)).toBeNull();
		expect(alertOf(ID, null, RoundState.Voting)).toBeNull();
	});

	it('stays dismissed for the round the owner said is theirs, and only that one', () => {
		const a = alertOf(ID, secret(), RoundState.Voting)!;
		expect(acknowledged(a, { [ID]: ackOf(a) })).toBe(true);
		expect(acknowledged({ ...a, round: 5 }, { [ID]: ackOf(a) })).toBe(false);
	});

	it('shows again once quorum elects a device, unless the owner acknowledged that device', () => {
		const voting = alertOf(ID, secret(), RoundState.Voting)!;
		const elected = alertOf(ID, secret({ executeAfter: 10_000n, recoveryRecipient: '0x' + 'Ab'.repeat(20) }), RoundState.TimeLock)!;
		expect(acknowledged(elected, { [ID]: ackOf(voting) })).toBe(false);
		expect(acknowledged(elected, { [ID]: ackOf(elected) })).toBe(true);
		expect(acknowledged({ ...elected, phase: 'window' }, { [ID]: ackOf(elected) })).toBe(true);
		expect(acknowledged({ ...elected, recipient: '0x' + '33'.repeat(20) }, { [ID]: ackOf(elected) })).toBe(false);
		expect(acknowledged(voting, { [ID]: 4 as never })).toBe(false);
	});

	it('names the elected device by its address', () => {
		const elected = alertOf(ID, secret({ executeAfter: 10_000n, recoveryRecipient: '0x7a3F' + '00'.repeat(16) + 'c91E' }), RoundState.TimeLock)!;
		expect(alertText(elected, 0).body).toContain('the new device 0x7a3F…c91E in');
		expect(alertText({ ...elected, phase: 'window' }, 0).body).toContain('The new device 0x7a3F…c91E can');
	});

	it('says how long the owner has', () => {
		const t = alertOf(ID, secret({ executeAfter: 10_000n }), RoundState.TimeLock)!;
		expect(alertText(t, 10_000 - 3 * 86400).body).toContain('in 3 days');
		expect(alertText(t, 10_000 - 3 * 3600).body).toContain('in 3 hours');
		expect(alertText(alertOf(ID, secret(), RoundState.Voting)!, 0).title).toMatch(/started recovering/);
		expect(alertText({ ...t, phase: 'window' }, 10_000).body).toContain('7 days more');
	});
});
