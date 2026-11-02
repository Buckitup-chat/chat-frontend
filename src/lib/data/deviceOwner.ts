// The device's owner is the first person to sign in on it (chat repo,
// pq_access_gating § Bootstrap and Owner): the server registers whoever first
// ingests their card here, and peer sync never registers anyone. A person
// whose card reached this device by sync before they signed in has nothing to
// ingest, so signing in claims an ownerless device explicitly: a signature over
// a fresh challenge for the card already stored there.
import { api } from '@/api/client';
import { toBase64Unpadded } from '@buckitup/pq-client/signature';

const USER_HASH = /^u_[0-9a-f]{128}$/;
const DEVICE_ID = /^[^.\s]+$/;
const CHALLENGE = /^[0-9a-f]{64}$/;

export interface DeviceIdentity {
	deviceId: string;
	adminHash: string | null;
}

export async function readDeviceIdentity(): Promise<DeviceIdentity | null> {
	let body: unknown;
	try {
		body = await api.getDeviceIdentity();
	} catch {
		return null;
	}
	if (!body || typeof body !== 'object') return null;
	const { device_id: deviceId, admin } = body as { device_id?: unknown; admin?: { user_hash?: unknown } | null };
	if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return null;
	if (admin === null || admin === undefined) return { deviceId, adminHash: null };
	const adminHash = admin.user_hash;
	if (typeof adminHash !== 'string' || !USER_HASH.test(adminHash)) return null;
	return { deviceId, adminHash };
}

/** owner: this account owns the device; other: someone else does; refused: the server did not accept the claim. */
export type DeviceClaim = 'owner' | 'other' | 'refused' | 'unavailable';

export interface DeviceClaimResult {
	claim: DeviceClaim;
	/** The device identity with the owner as it stands after the claim; null when it could not be read. */
	identity: DeviceIdentity | null;
}

/** Claims the device for `userHash` when it has no owner; `sign` signs the challenge bytes with that account's key. */
export async function claimDeviceIfUnowned(userHash: string, sign: (challenge: Uint8Array) => Promise<Uint8Array>): Promise<DeviceClaimResult> {
	const identity = await readDeviceIdentity();
	if (!identity) return { claim: 'unavailable', identity };
	if (identity.adminHash !== null) return { claim: identity.adminHash === userHash ? 'owner' : 'other', identity };
	try {
		const { challenge_id: challengeId, challenge } = await api.getChallenge();
		if (typeof challengeId !== 'string' || typeof challenge !== 'string' || !CHALLENGE.test(challenge)) {
			return { claim: 'unavailable', identity };
		}
		const signature = toBase64Unpadded(await sign(new TextEncoder().encode(challenge)));
		const resp = await api.claimOwner(userHash, challengeId, signature);
		if (!resp.ok) return { claim: resp.status >= 500 ? 'unavailable' : 'refused', identity };
		const admin = ((await resp.json().catch(() => null)) as { admin?: unknown } | null)?.admin;
		if (typeof admin !== 'string' || !USER_HASH.test(admin)) return { claim: 'unavailable', identity };
		return { claim: admin === userHash ? 'owner' : 'other', identity: { ...identity, adminHash: admin } };
	} catch {
		return { claim: 'unavailable', identity };
	}
}
