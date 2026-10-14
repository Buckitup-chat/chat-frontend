// The device's owner is the first person to sign in on it (chat repo,
// pq_access_gating § Bootstrap and Owner): the server registers whoever first
// ingests their card here, and peer sync never registers anyone. A person
// whose card reached this device by sync before they signed in has nothing to
// ingest, so signing in claims an ownerless device explicitly: a signature over
// a fresh challenge for the card already stored there.
import { api } from '@/api/client';
import { toBase64 } from '@/lib/pq/signature';
import { readDeviceIdentity } from './contactVouches';

/** owner: this account owns the device; other: someone else does; refused: the server did not accept the claim. */
export type DeviceClaim = 'owner' | 'other' | 'refused' | 'unavailable';

/** Claims the device for `userHash` when it has no owner; `sign` signs the challenge bytes with that account's key. */
export async function claimDeviceIfUnowned(userHash: string, sign: (challenge: Uint8Array) => Promise<Uint8Array>): Promise<DeviceClaim> {
	const identity = await readDeviceIdentity();
	if (!identity) return 'unavailable';
	if (identity.adminHash !== null) return identity.adminHash === userHash ? 'owner' : 'other';
	try {
		const { challenge_id: challengeId, challenge } = await api.getChallenge();
		const signature = toBase64(await sign(new TextEncoder().encode(challenge))).replace(/=+$/, '');
		const resp = await api.claimOwner(userHash, challengeId, signature);
		if (!resp.ok) return 'refused';
		const body = (await resp.json().catch(() => null)) as { admin?: unknown } | null;
		return body?.admin === userHash ? 'owner' : 'other';
	} catch {
		return 'unavailable';
	}
}
