// What the recovery screens say: the round's phase for the person recovering,
// and how long is left. Pure, so the words are tested once.
import { span } from '@/lib/recovery/rounds';

/** The round as the person recovering reads it: a title and a line under it. */
export const phaseText = (round, approvals, now) => {
	if (!round) return { title: 'Waiting for your guardian', body: 'Once a guardian sends their request, this screen follows the recovery.' };
	switch (round.phase) {
		case 'none':
			return { title: 'Waiting for a guardian to start', body: 'After you read the words to a guardian and they match, the guardian starts the recovery.' };
		case 'voting':
			return {
				title: `${approvals ?? 0} of ${round.quorum} guardians approved`,
				body: 'Call your other guardians: each of them checks the words and approves this device.',
			};
		case 'timelock':
			return {
				title: `Approved. Pieces come back in ${span(round.executeAfter - now)}`,
				body: 'This wait lets you stop the recovery from a device you still have, if it is not you.',
			};
		case 'window':
			return {
				title: 'Your guardians are sending their pieces',
				body: `The pieces can be collected for ${span(round.expiresAt - now)} more.`,
			};
		case 'elsewhere':
			return { title: 'The guardians approved another device', body: 'If that was not you, start over and ask your guardians to check the words again.' };
		case 'stopped':
			return { title: 'The recovery was stopped', body: 'Someone stopped it from a device of your account. If it was not you, start over.' };
		case 'expired':
			return { title: 'The time to collect the pieces ran out', body: 'Start over with a new key; your guardians approve again.' };
		default:
			return { title: '', body: '' };
	}
};

export const nodeStateText = (n) => (n.state === 'released' ? 'sent its part' : n.state === 'failed' ? `not yet: ${n.detail}` : 'waiting');
