// What the guardian's help screens say about a help in progress (plan § 7.5).

/** A help's state, as the guardian's list shows it. */
export const helpStateText = (s) =>
	({
		asked: 'waiting for their answer',
		approved: s.mode === 'text' ? 'approved — the piece can be made once the waiting period is over' : 'approved — your piece goes to them once the waiting period is over',
		ready: 'ready: make the piece and send it to them',
		sent: 'your piece was sent',
		stopped: `stopped: ${s.reason || 'the recovery ended'}`,
	})[s.step] ?? s.step;

/** Whether the help needs the guardian to act. */
export const helpNeedsYou = (s) => s.step === 'ready' || s.step === 'asked';
