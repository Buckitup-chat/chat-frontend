// The device's identity as the server reports it: its id and its owner, or
// none, and nothing at all for an answer that is not one.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ getDeviceIdentity: vi.fn() }));
vi.mock('@/api/client', () => ({ api }));

const { readDeviceIdentity } = await import('@/lib/data/deviceOwner');

const ME = 'u_' + 'a'.repeat(128);

beforeEach(() => vi.clearAllMocks());

describe('readDeviceIdentity', () => {
	it('reads the device id and its owner', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: ME } });
		expect(await readDeviceIdentity()).toEqual({ deviceId: 'BK-001', adminHash: ME });
	});

	it('reads a device with no owner yet', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		expect(await readDeviceIdentity()).toEqual({ deviceId: 'BK-001', adminHash: null });
	});

	it('gives nothing for a failed request or an answer that is not an identity', async () => {
		api.getDeviceIdentity.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await readDeviceIdentity()).toBeNull();
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'a.b', admin: null });
		expect(await readDeviceIdentity()).toBeNull();
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: 'nobody' } });
		expect(await readDeviceIdentity()).toBeNull();
	});
});
