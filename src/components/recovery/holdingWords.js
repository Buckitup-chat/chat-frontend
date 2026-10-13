// What the keeping screens say (plan § 7.3): a kept piece's state as its
// guardian reads it, a guardian's report as its owner reads it, and the
// prompt before a piece is given back. The rules live in src/lib/recovery.

/** A kept piece's state, as the guardian's card and list show it; `saving` while the dialog's share is not in the slot yet. */
export const keptStateText = (state, detail = '') =>
	({
		saving: 'saving…',
		pending: 'waiting for the network',
		stored: 'stored ✓',
		unverified: `problem: ${detail || 'it does not check'}`,
		unreachable: 'problem: its network is one this app cannot reach',
		unrequested: 'problem: you did not agree to be their guardian on its network',
		conflict: `refused: ${detail}`,
		given_back: 'given back',
		dropped: detail ? `dropped: ${detail}` : 'dropped',
	})[state] ?? state;

/** Whether the state is a problem the guardian should look at. */
export const keptStateIsProblem = (state) => ['unverified', 'unreachable', 'unrequested', 'conflict'].includes(state);

/**
 * A `recovery_holding` as a service line: the owner reads what the guardian
 * did with their piece; the guardian reads what they told the owner.
 */
export const holdingLineText = ({ state, detail, mine }, peerName) => {
	const why = detail ? `: ${detail}` : '';
	if (mine) {
		return (
			{
				stored: `You stored ${peerName}'s backup piece`,
				unverified: `You told ${peerName} their backup piece could not be verified${why}`,
				unreachable: `You told ${peerName} their backup piece is for a network this app cannot reach`,
				unrequested: `You told ${peerName} you did not agree to keep this piece`,
				given_back: `You gave ${peerName}'s backup piece back`,
				dropped: `You dropped ${peerName}'s backup piece${why}`,
			}[state] ?? `You told ${peerName} where their backup piece stands`
		);
	}
	return (
		{
			stored: `${peerName} stored your backup piece`,
			unverified: `${peerName} could not verify your backup piece${why}`,
			unreachable: `${peerName} keeps your backup piece but cannot reach its network`,
			unrequested: `${peerName} keeps your backup piece but did not agree to be your guardian on its network`,
			given_back: `${peerName} gave your backup piece back`,
			dropped: `${peerName} no longer keeps your backup piece${why}`,
		}[state] ?? `${peerName} sent a status of your backup piece this app does not know`
	);
};

/** Asks before a piece is given back; resolves to whether to go on. */
export const confirmGiveBack = async (swal, ownerName) => {
	const { isConfirmed } = await swal.fire({
		icon: 'question',
		title: `Give back ${ownerName}'s backup piece?`,
		text:
			`Your copy is removed from your account, and ${ownerName} is asked to reshare their backup without you. ` +
			'It is a request: until they do, the network still lists you as their guardian.',
		showCancelButton: true,
		confirmButtonText: 'Give back',
	});
	return !!isConfirmed;
};
