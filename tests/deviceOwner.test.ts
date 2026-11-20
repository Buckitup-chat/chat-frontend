// The device's identity as the server reports it: its id and its owner, or
// none; and for a read that fails, whether any answer came at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportError } from '@buckitup/pq-client/transport';

const api = vi.hoisted(() => ({ getDeviceIdentity: vi.fn() }));
vi.mock('@/api/client', () => ({ api }));

const { readDeviceIdentity } = await import('@/lib/data/deviceOwner');

const ME = 'u_' + 'a'.repeat(128);

beforeEach(() => vi.clearAllMocks());

describe('readDeviceIdentity', () => {
	it('reads the device id and its owner', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: ME } });
		expect(await readDeviceIdentity()).toEqual({ kind: 'identity', identity: { deviceId: 'BK-001', adminHash: ME } });
	});

	it('reads a device with no owner yet', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		expect(await readDeviceIdentity()).toEqual({ kind: 'identity', identity: { deviceId: 'BK-001', adminHash: null } });
	});

	it('tells a request that got no answer from a server that answered with no identity', async () => {
		const kind = async () => (await readDeviceIdentity()).kind;
		api.getDeviceIdentity.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await kind()).toBe('no-answer');
		api.getDeviceIdentity.mockRejectedValue(new TransportError('device_identity: timed out', { kind: 'timeout' }));
		expect(await kind()).toBe('no-answer');

		api.getDeviceIdentity.mockRejectedValue(new TransportError('device_identity: HTTP 500', { status: 500 }));
		expect(await kind()).toBe('failed');
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'a.b', admin: null });
		expect(await kind()).toBe('failed');
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: 'nobody' } });
		expect(await kind()).toBe('failed');
	});
});
