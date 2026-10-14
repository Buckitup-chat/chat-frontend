// Signing in on a device with no owner claims it; a device that has one is
// left alone, and the claim is a signature over the server's challenge.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

const api = vi.hoisted(() => ({
	getDeviceIdentity: vi.fn(),
	getChallenge: vi.fn(),
	claimOwner: vi.fn(),
}));
vi.mock('@/api/client', () => ({ api }));

const { claimDeviceIfUnowned } = await import('@/lib/data/deviceOwner');

const ME = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);
const keys = ml_dsa87.keygen(new Uint8Array(32).fill(7));
const sign = vi.fn(async (bytes: Uint8Array) => ml_dsa87.sign(bytes, keys.secretKey));
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
	vi.clearAllMocks();
	api.getChallenge.mockResolvedValue({ challenge_id: 'c1', challenge: 'ab'.repeat(32) });
});

describe('claimDeviceIfUnowned', () => {
	it('claims an ownerless device with a signature over the challenge', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		api.claimOwner.mockResolvedValue(response(200, { admin: ME }));

		expect(await claimDeviceIfUnowned(ME, sign)).toBe('owner');

		const [userHash, challengeId, signature] = api.claimOwner.mock.calls[0];
		expect([userHash, challengeId]).toEqual([ME, 'c1']);
		expect(signature).not.toMatch(/=$/);
		const sigBytes = Uint8Array.from(atob(signature + '='.repeat((4 - (signature.length % 4)) % 4)), (c) => c.charCodeAt(0));
		expect(ml_dsa87.verify(sigBytes, new TextEncoder().encode('ab'.repeat(32)), keys.publicKey)).toBe(true);
	});

	it('leaves a device that already has an owner alone', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: OTHER } });

		expect(await claimDeviceIfUnowned(ME, sign)).toBe('other');
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: { user_hash: ME } });
		expect(await claimDeviceIfUnowned(ME, sign)).toBe('owner');

		expect(api.claimOwner).not.toHaveBeenCalled();
		expect(sign).not.toHaveBeenCalled();
	});

	it('reports the owner the server answers with when someone claimed first', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		api.claimOwner.mockResolvedValue(response(200, { admin: OTHER }));

		expect(await claimDeviceIfUnowned(ME, sign)).toBe('other');
	});

	it('reports a refused claim', async () => {
		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		api.claimOwner.mockResolvedValue(response(401, { error: 'unknown_user' }));

		expect(await claimDeviceIfUnowned(ME, sign)).toBe('refused');
	});

	it('does not claim when the device identity cannot be read, or the key is not open', async () => {
		api.getDeviceIdentity.mockRejectedValue(new Error('offline'));
		expect(await claimDeviceIfUnowned(ME, sign)).toBe('unavailable');
		expect(api.claimOwner).not.toHaveBeenCalled();

		api.getDeviceIdentity.mockResolvedValue({ device_id: 'BK-001', admin: null });
		const locked = vi.fn(async () => {
			throw new Error('vault locked');
		});
		expect(await claimDeviceIfUnowned(ME, locked)).toBe('unavailable');
		expect(api.claimOwner).not.toHaveBeenCalled();
	});
});
