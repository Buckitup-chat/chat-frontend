// The owner's side of § Holding (chat repo: pq_recovery_shares): where each
// guardian's piece stands, from what the guardian said in their dialog. The
// roster counts a holder only on `stored`; `delivered`, the dialog's own
// receipt, says the piece arrived and nothing more.
import { holdingReportsOf, type ReportedState } from './holdings';
import type { BackupRun } from './backupRun';

/** A guardian's piece, as the backup screens show it. */
export type Delivery = 'waiting' | 'sent' | 'delivered' | 'stored' | 'problem' | 'given_back' | 'dropped';

/** What each state a guardian reports is to the owner: every kept-with-a-problem state is one problem, a prompt to reshare. */
export const DELIVERY_OF: Readonly<Record<ReportedState, Delivery>> = {
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
	const secretRef = `${run.deployment}/${run.secretId.toLowerCase()}`;
	return Object.fromEntries(
		Object.entries(run.sent ?? {}).map(([guardian, s]) => [guardian, { secretRef, version: run.version!, splitId: run.splitId, shareIndex: s.shareIndex, messageId: s.messageId }]),
	);
};

export interface Receipt {
	state: Delivery;
	/** The guardian's reason, for a problem. */
	detail: string;
}

/** What one read of a guardian's dialog shows (dialogs.store readPeerParts). */
export interface PeerRead {
	messages: readonly { senderHash: string; parts: readonly { kind: string }[] }[];
	/** Message ids the guardian's delivered receipt names. */
	delivered: readonly string[];
}

/**
 * Where `guardian`'s piece stands by their dialog: their latest word on it,
 * else `delivered` when the dialog says it arrived, else null — the dialog
 * shows nothing beyond what the run knows.
 */
export const receiptOf = (guardian: string, sent: SentShare, read: PeerRead): Receipt | null => {
	const said = holdingReportsOf(read.messages, { [guardian]: sent })[guardian];
	if (said) return { state: DELIVERY_OF[said.state], detail: said.state === 'stored' ? '' : said.detail };
	return read.delivered.includes(sent.messageId) ? { state: 'delivered', detail: '' } : null;
};
