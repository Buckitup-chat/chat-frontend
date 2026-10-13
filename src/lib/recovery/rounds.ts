// A recovery round on the owner's own secret, as the app warns about it
// (plan § 7.4, "Alerts in the app"; chat repo pq_recovery_services
// § Notifications). Anyone with enough guardians can start one; the owner's
// defence is the timelock and a veto from any device still in their hands,
// so a live round shows over every screen until it ends or the owner says it
// is theirs. Pure: the chain's answers come in, the banner's words go out.
import { ZeroAddress } from 'ethers';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import type { SecretState } from './chain';

export type RoundPhase = 'voting' | 'timelock' | 'window';

export interface RoundAlert {
	secretId: string;
	/** The round number: an acknowledgement or a dismissal is for one round only. */
	round: number;
	phase: RoundPhase;
	/** Unix seconds: when the recipient may decrypt; 0 while voting. */
	executeAfter: number;
	/** Unix seconds: when that right ends; 0 while voting. */
	expiresAt: number;
	/** The elected address, once quorum is reached. */
	recipient: string | null;
}

const PHASES: Partial<Record<RoundState, RoundPhase>> = {
	[RoundState.Voting]: 'voting',
	[RoundState.TimeLock]: 'timelock',
	[RoundState.Window]: 'window',
};

/** Whether a round is live in `state`: voting, in its timelock, or in its window. */
export const roundIsLive = (state: RoundState): boolean => !!PHASES[state];

/** The alert for `secret` in `state`, or null when no round is live (none, or expired) or the secret is revoked. */
export const alertOf = (secretId: string, secret: SecretState | null, state: RoundState): RoundAlert | null => {
	const phase = PHASES[state];
	if (!secret || secret.revoked || !phase) return null;
	const voting = phase === 'voting';
	const executeAfter = voting ? 0 : Number(secret.executeAfter);
	return {
		secretId,
		round: Number(secret.recoveryRound),
		phase,
		executeAfter,
		expiresAt: voting ? 0 : executeAfter + Number(secret.recoveryWindow),
		recipient: !voting && secret.recoveryRecipient && secret.recoveryRecipient !== ZeroAddress ? secret.recoveryRecipient : null,
	};
};

/** What the owner said is theirs, per secret: a round, and once quorum is reached the device it elected. */
export interface RoundAck {
	round: number;
	/** The recipient acknowledged, lowercase; null when acknowledged while voting. */
	recipient: string | null;
}

/** What acknowledging `alert` records. */
export const ackOf = (alert: RoundAlert): RoundAck => ({ round: alert.round, recipient: alert.recipient?.toLowerCase() ?? null });

/**
 * Whether the owner already said this round is theirs. While voting, the
 * round is enough; once quorum elects a device, only an acknowledgement of
 * that device is: a round acknowledged while voting shows again when it
 * hands access to someone, so the owner can check it is their new device.
 */
export const acknowledged = (alert: RoundAlert, ack: Record<string, RoundAck | undefined>): boolean => {
	const a = ack[alert.secretId];
	if (!a || typeof a !== 'object' || a.round !== alert.round) return false;
	if (alert.phase === 'voting') return true;
	return !!a.recipient && a.recipient === alert.recipient?.toLowerCase();
};

/** "0x7a3F…c91E": enough of an address to tell one device from another. */
const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const span = (sec: number): string => {
	const s = Math.max(0, Math.round(sec));
	if (s >= 2 * 86400) return `${Math.floor(s / 86400)} days`;
	if (s >= 2 * 3600) return `${Math.floor(s / 3600)} hours`;
	if (s >= 120) return `${Math.floor(s / 60)} minutes`;
	return 'a minute';
};

const device = (alert: RoundAlert) => (alert.recipient ? ` ${shortAddress(alert.recipient)}` : '');

/** The banner's words for `alert` at unix time `now`; once a device is elected, it is named by its address. */
export const alertText = (alert: RoundAlert, now: number): { title: string; body: string } => {
	if (alert.phase === 'voting') {
		return {
			title: 'Someone started recovering your account',
			body: 'Your guardians are being asked to approve. If this is not you, stop it now.',
		};
	}
	if (alert.phase === 'timelock') {
		return {
			title: 'A recovery of your account was approved',
			body: `Access goes to the new device${device(alert)} in ${span(alert.executeAfter - now)}. If this is not your device, stop it before then.`,
		};
	}
	return {
		title: 'Access to your account has been handed over',
		body: `The new device${device(alert)} can open your backup for ${span(alert.expiresAt - now)} more. If this is not your device, stop it now.`,
	};
};
