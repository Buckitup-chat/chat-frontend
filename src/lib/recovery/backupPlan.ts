// What a community backup is set up with, and the rules a setup must keep
// (chat repo: pq_recovery_shares § Issuing; docs/backup-recovery-plan.md
// § 7.2; screens: docs/design-recovery-backup.md). Pure: the screens and the
// run ask it, and it says what the defaults are and what is wrong.

/** The contract's bounds on a secret's timelock and decrypt window, in seconds. */
export const DELAY_BOUNDS = { min: 10 * 60, max: 365 * 86400 } as const;
export const WINDOW_BOUNDS = { min: 3600, max: 30 * 86400 } as const;
/** The contract takes at most this many guardians; the free service, at most RELAYER_MAX_GUARDIANS. */
export const CONTRACT_MAX_GUARDIANS = 50;
export const RELAYER_MAX_GUARDIANS = 32;
export const MIN_NODE_OPERATORS = 3;
export const MAX_DEFAULT_NODES = 5;
/** Spare pieces kept in the owner's account: at least one — the pieces must outnumber the guardians (§ Issuing, step 2) — and a few at most. */
export const SPARES_BOUNDS = { min: 1, max: 10 } as const;

export interface BackupSettings {
	/** Shamir shares needed to rebuild the friends' half. */
	threshold: number;
	/** Guardian approvals the contract needs; at least `threshold`. */
	approvals: number;
	/** Shares beyond the guardians', kept in the owner's account. */
	spares: number;
	/** Seconds after a recovery starts before access returns: the owner's time to stop it. */
	delaySec: number;
	/** Seconds the recovered key can be used once the wait is over. */
	windowSec: number;
	/** Node shares needed to rebuild the node half. */
	nodeThreshold: number;
}

/** A majority of `n`, and never fewer than 2 (pq_recovery_services § Choosing nodes; § 7.2's table). */
export const majority = (n: number): number => Math.max(2, Math.floor(n / 2) + 1);

/** The Simple screen's settings for `guardians` guardians and `nodes` nodes. */
export const defaultSettings = (guardians: number, nodes: number): BackupSettings => {
	const threshold = Math.min(majority(guardians), Math.max(guardians, 2));
	return {
		threshold,
		approvals: threshold,
		spares: 2,
		delaySec: 3 * 86400,
		windowSec: 7 * 86400,
		nodeThreshold: Math.min(majority(nodes), Math.max(nodes, 2)),
	};
};

/** Guardians who must approve and hand back a share: past quorum further approvals revert, so the larger of the two. */
export const neededGuardians = (s: Pick<BackupSettings, 'threshold' | 'approvals'>): number => Math.max(s.threshold, s.approvals);

export type SettingsProblem =
	| { field: 'guardians'; reason: 'too_few' | 'too_many' }
	| { field: 'threshold'; reason: 'out_of_range' }
	| { field: 'approvals'; reason: 'below_threshold' | 'above_guardians' }
	| { field: 'spares'; reason: 'out_of_range' }
	| { field: 'delaySec' | 'windowSec'; reason: 'out_of_range' }
	| { field: 'nodeThreshold'; reason: 'out_of_range' };

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Everything wrong with `s` for `guardians` guardians and `nodes` nodes; empty
 * when it can be created. The Shamir split takes at most 255 shares in all.
 */
export const settingsProblems = (s: BackupSettings, guardians: number, nodes: number): SettingsProblem[] => {
	const out: SettingsProblem[] = [];
	if (guardians < 2) out.push({ field: 'guardians', reason: 'too_few' });
	if (guardians > CONTRACT_MAX_GUARDIANS) out.push({ field: 'guardians', reason: 'too_many' });
	if (!intIn(s.threshold, 2, Math.max(guardians, 2))) out.push({ field: 'threshold', reason: 'out_of_range' });
	// Past quorum further approvals revert, and a guardian who did not approve
	// does not release: fewer approvals than shares and an honest recovery
	// never collects enough (§ Issuing, step 3).
	if (s.approvals < s.threshold) out.push({ field: 'approvals', reason: 'below_threshold' });
	else if (s.approvals > guardians) out.push({ field: 'approvals', reason: 'above_guardians' });
	if (!intIn(s.spares, SPARES_BOUNDS.min, Math.min(SPARES_BOUNDS.max, 255 - guardians))) out.push({ field: 'spares', reason: 'out_of_range' });
	if (!intIn(s.delaySec, DELAY_BOUNDS.min, DELAY_BOUNDS.max)) out.push({ field: 'delaySec', reason: 'out_of_range' });
	if (!intIn(s.windowSec, WINDOW_BOUNDS.min, WINDOW_BOUNDS.max)) out.push({ field: 'windowSec', reason: 'out_of_range' });
	if (!intIn(s.nodeThreshold, 2, Math.max(nodes - 1, 2))) out.push({ field: 'nodeThreshold', reason: 'out_of_range' });
	return out;
};

/**
 * What is wrong with a finished backup's waiting period and time to finish
 * set to `delaySec` and `windowSec`: the rest of `settings` stays as it is,
 * so only those two can be wrong.
 */
export const policyProblems = (settings: BackupSettings, delaySec: number, windowSec: number, guardians: number, nodes: number): SettingsProblem[] =>
	settingsProblems({ ...settings, delaySec, windowSec }, guardians, nodes).filter((p) => p.field === 'delaySec' || p.field === 'windowSec');

/** Whether the free service can register it: it takes at most RELAYER_MAX_GUARDIANS shares (the spares stay off chain). */
export const relayerCanTake = (guardians: number): boolean => guardians <= RELAYER_MAX_GUARDIANS;

export type HealthLevel = 'spare_2' | 'spare_1' | 'at_threshold' | 'broken';

/**
 * The one number that answers "is my backup real": guardians holding a share
 * against those needed. Two or more above it is healthy; one, a warning; at it,
 * one loss from failing; below it, the backup does not work.
 */
export const healthOf = (holders: number, needed: number): HealthLevel => {
	if (holders < needed) return 'broken';
	if (holders === needed) return 'at_threshold';
	return holders - needed === 1 ? 'spare_1' : 'spare_2';
};

/** "1 guardian", "3 guardians". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A duration as the screens say it: whole days, else hours, else minutes. */
export const durationText = (sec: number): string => {
	if (sec % 86400 === 0) return plural(sec / 86400, 'day');
	if (sec % 3600 === 0) return plural(sec / 3600, 'hour');
	return plural(Math.round(sec / 60), 'minute');
};
