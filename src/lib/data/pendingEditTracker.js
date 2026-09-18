let nextClaimToken = 0;

export function claimPendingEdit(map, messageId, text) {
	const token = ++nextClaimToken;
	map.set(messageId, { text, status: 'syncing', token, targetSignHash: null, targetOwnerTimestamp: null });
	return token;
}
export function submitPendingEdit(map, messageId, token, targetSignHash, targetOwnerTimestamp) {
	const current = map.get(messageId);
	if (!current || current.token !== token) return false;
	map.set(messageId, { text: current.text, status: 'awaiting_echo', token, targetSignHash, targetOwnerTimestamp });
	return true;
}

export function failPendingEdit(map, messageId, token, error) {
	const current = map.get(messageId);
	if (!current || current.token !== token) return false;
	map.set(messageId, {
		text: current.text,
		status: 'error',
		error,
		token,
		targetSignHash: current.targetSignHash,
		targetOwnerTimestamp: current.targetOwnerTimestamp,
	});
	return true;
}

export function reconcilePendingEditsWithVerifiedRows(map, verifiedRevisions) {
	const verifiedSignHashByMessageId = new Map();
	for (const rev of verifiedRevisions) {
		if (rev.signHash) verifiedSignHashByMessageId.set(rev.id, rev.signHash);
	}

	const cleared = [];
	for (const [messageId, entry] of map) {
		if (entry.status !== 'awaiting_echo' || !entry.targetSignHash) continue;
		if (verifiedSignHashByMessageId.get(messageId) === entry.targetSignHash) {
			map.delete(messageId);
			cleared.push(messageId);
		}
	}
	return cleared;
}
