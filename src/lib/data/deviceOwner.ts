// The device's identity and its owner (chat repo, pq_access_gating § Bootstrap
// and Owner). The owner is whoever first ingests their card here over HTTP;
// peer sync starts only once the device has an owner (OwnerBootstrap,
// PeerSyncDecider), so no card reaches an ownerless device by sync and there
// is nothing for a client to claim.
import { api } from '@/api/client';

const USER_HASH = /^u_[0-9a-f]{128}$/;
const DEVICE_ID = /^[^.\s]+$/;

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
