import { currentSessionToken, sameSessionToken, SessionFencedError, type SessionToken } from './outbox';

export { SessionFencedError };

export function pinActiveSession(ownerHash: string, step: string): SessionToken {
	const token = currentSessionToken();
	if (!token || token.userHash !== ownerHash) {
		throw new SessionFencedError(`${step}: fenced — no active session bound to ${ownerHash}`);
	}
	return token;
}

export function assertSessionUnchanged(pinned: SessionToken, step: string): void {
	if (!sameSessionToken(pinned, currentSessionToken())) {
		throw new SessionFencedError(`${step}: fenced — active session changed since this intent's session was pinned`);
	}
}
