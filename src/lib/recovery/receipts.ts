// The owner's side of § Holding (chat repo: pq_recovery_shares): where each
// guardian's piece stands, from what the guardian said in their dialog. The
// roster counts a holder only on `stored`; `delivered`, the dialog's own
// receipt, says the piece arrived and nothing more.
import type { RecoveryHoldingPart } from '@/lib/pq/content';
import { isReportedState, type ReportedState } from './holdings';
import { secretRefIn } from './deployments';
import type { BackupRun } from './backupRun';

/** A guardian's piece, as the backup screens show it. */
export type Delivery = 'waiting' | 'sent' | 'delivered' | 'stored' | 'problem' | 'given_back' | 'dropped';

/** A piece in these states no longer counts: each is a prompt to reshare, and its guardian is handed no spare. */
export const LOST_DELIVERIES: readonly Delivery[] = ['problem', 'given_back', 'dropped'];

/** What each state a guardian reports is to the owner: every kept-with-a-problem state is one problem, a prompt to reshare. */
const DELIVERY_OF: Readonly<Record<ReportedState, Delivery>> = {
	stored: 'stored',
	unverified: 'problem',
	unreachable: 'problem',
	unrequested: 'problem',
	given_back: 'given_back',
	dropped: 'dropped',
};

export interface SentShare {
	secretRef: string;
	version: number;
	splitId: string;
	shareIndex: number;
	/** The message the share went in. */
	messageId: string;
}

/** Each guardian's share as their reports name it; empty until the run has registered its secret. */
export const sentSharesOf = (run: Pick<BackupRun, 'deployment' | 'secretId' | 'version' | 'splitId' | 'sent'> | null | undefined): Record<string, SentShare> => {
	if (!run?.secretId || run.version == null) return {};
	const secretRef = secretRefIn(run.deployment, run.secretId);
	return Object.fromEntries(
		Object.entries(run.sent ?? {}).map(([guardian, s]) => [guardian, { secretRef, version: run.version!, splitId: run.splitId, shareIndex: s.shareIndex, messageId: s.messageId }]),
	);
};

type DialogMessage = { senderHash: string; parts: readonly { kind: string }[] };

/** Whether `part` is a report on `sent`, in a state the owner reads. */
export const isReportOn = (sent: SentShare) => (part: { kind: string }): boolean => {
	if (part.kind !== 'recovery_holding') return false;
	const r = part as RecoveryHoldingPart;
	return r.secretRef === sent.secretRef && r.version === sent.version && r.splitId === sent.splitId && r.shareIndex === sent.shareIndex && isReportedState(r.state);
};

/**
 * `guardian`'s latest word on the share they were sent, from messages in
 * dialog order: only the guardian the share went to can state it, and only
 * about that share.
 */
export const latestReport = (messages: readonly DialogMessage[], guardian: string, sent: SentShare): { state: ReportedState; detail: string } | null => {
	const about = isReportOn(sent);
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].senderHash !== guardian) continue;
		const parts = messages[i].parts.filter(about) as RecoveryHoldingPart[];
		const last = parts[parts.length - 1];
		if (last) return { state: last.state as ReportedState, detail: last.detail };
	}
	return null;
};

export interface Receipt {
	state: Delivery;
	/** The guardian's reason, for a problem. */
	detail: string;
}

/** What one read of a guardian's dialog shows (dialogs.store readPeerParts). */
export interface PeerRead {
	messages: readonly DialogMessage[];
	/** Message ids the guardian's delivered receipt names. */
	delivered: readonly string[];
}

/**
 * Where `guardian`'s piece stands by their dialog: their latest word on it,
 * else `delivered` when the dialog says it arrived, else null — the dialog
 * shows nothing beyond what the run knows.
 */
export const receiptOf = (guardian: string, sent: SentShare, read: PeerRead): Receipt | null => {
	const said = latestReport(read.messages, guardian, sent);
	if (said) return { state: DELIVERY_OF[said.state], detail: said.state === 'stored' ? '' : said.detail };
	return read.delivered.includes(sent.messageId) ? { state: 'delivered', detail: '' } : null;
};
