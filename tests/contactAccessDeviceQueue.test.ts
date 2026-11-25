import { beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = { id: string; userHash: string; createdAt: number; relation: string; intent: Record<string, unknown> };

const h = vi.hoisted(() => ({
	entries: [] as Entry[],
	resolve: vi.fn(async (id: string, _outcome: { outcome: string }) => {
		const at = h.entries.findIndex((e) => e.id === id);
		if (at >= 0) h.entries[at] = { ...h.entries[at], intent: { resolved: true } };
		return true;
	}),
	update: vi.fn(async (id: string, intent: Record<string, unknown>) => {
		const at = h.entries.findIndex((e) => e.id === id);
		if (at >= 0) h.entries[at] = { ...h.entries[at], intent };
		return true;
	}),
	deviceId: 'device-a',
	issuer: 'u_' + 'a'.repeat(128),
	subject: 'u_' + 'b'.repeat(128),
}));
vi.mock('@/lib/data/intents', () => ({
	intentsOf: async () => ({ entries: h.entries.filter((e) => e.intent.resolved !== true), issues: [] }),
	getIntent: async (id: string) => h.entries.find((e) => e.id === id) ?? null,
	resolveIntent: h.resolve,
	updateIntent: h.update,
	enqueueIntent: vi.fn(),
}));
vi.mock('@/lib/data/outbox', () => ({
	withAccountLock: async (_key: string, work: () => Promise<unknown>) => work(),
	pendingEntries: async () => [],
	quarantinedEntries: async () => [],
	discardEntry: vi.fn(),
	SessionFencedError: class extends Error {},
}));
vi.mock('@/lib/data/deviceOwner', () => ({ readDeviceIdentity: async () => ({ deviceId: h.deviceId, adminHash: h.issuer }) }));
vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async () => 'verified-key' }));
vi.mock('@/lib/data/rowVerification', () => ({ verifyReplicatedRow: async () => ({ status: 'verified' }) }));
vi.mock('@/lib/data/keyCustody', () => ({ resolveSigningKey: async () => new Uint8Array(32) }));
vi.mock('@/lib/data/shapeRead', () => ({
	readShapeOnce: async () => ['read', 'write'].map((scope) => ({
		kind: `device.${h.deviceId}.storage.${scope}`,
		issuer_hash: h.issuer, subject_hash: h.subject,
		owner_timestamp: 100, deleted_flag: false, sign_b64: 'verified-in-this-test',
	})),
}));
vi.mock('@/lib/data/ingest', () => ({ sendMutationsAndAwaitShape: vi.fn(), IngestError: class extends Error {} }));
const { applyContactAccessIntent } = await import('@/lib/data/contactVouches');

const session = { issuerHash: h.issuer, signingKey: new Uint8Array(32), stillCurrent: () => true };
const request = (id: string, createdAt: number, fields: Record<string, unknown>): Entry => ({
	id, userHash: h.issuer, createdAt, relation: 'vouch_tokens',
	intent: { kind: 'contact-access', subjectHash: h.subject, granted: true, ...fields },
});
const apply = (entry: Entry) => applyContactAccessIntent(entry as unknown as Parameters<typeof applyContactAccessIntent>[0], session);
const outcomeOf = (id: string) => h.resolve.mock.calls.filter(([resolved]) => resolved === id).map(([, o]) => o.outcome);

beforeEach(() => {
	h.entries = [];
	h.deviceId = 'device-a';
	h.resolve.mockClear();
	h.update.mockClear();
});

describe('contact-access requests are queued per issuer, device and contact', () => {
	it('settles a current-device grant even while a newer request for another device is pending', async () => {
		const forA = request('a', 1, { deviceId: 'device-a' });
		const forB = request('b', 2, { deviceId: 'device-b', granted: false });
		h.entries = [forA, forB];

		await apply(forA);
		expect(outcomeOf('a')).toEqual(['applied']);
		expect(outcomeOf('b')).toEqual([]);
	});

	it('a request bound to another device is skipped without touching the current device\'s request', async () => {
		const forA = request('a', 1, { deviceId: 'device-a' });
		const forB = request('b', 2, { deviceId: 'device-b', granted: false });
		h.entries = [forA, forB];

		await apply(forB);
		expect(outcomeOf('b')).toEqual(['skipped:device-changed']);
		expect(outcomeOf('a')).toEqual([]);

		await apply(forA);
		expect(outcomeOf('a')).toEqual(['applied']);
	});

	it('a request stored without a device binds to the device that answers before anything is planned', async () => {
		const legacy = request('legacy', 1, {});
		h.entries = [legacy];

		await apply(legacy);
		expect(h.update).toHaveBeenCalledWith('legacy', expect.objectContaining({ deviceId: 'device-a', purpose: expect.stringContaining('|device-a|') }));
		expect(outcomeOf('legacy')).toEqual(['applied']);
	});

	it('a newer request without a device supersedes an older one for the device that answers', async () => {
		const older = request('older', 1, { deviceId: 'device-a', granted: false });
		const legacy = request('legacy', 2, {});
		h.entries = [older, legacy];

		await apply(older);
		expect(outcomeOf('older')).toEqual(['superseded']);
	});

	it('a newer request without a device does not supersede a request bound to another device', async () => {
		const forB = request('for-b', 1, { deviceId: 'device-b', granted: false });
		const legacy = request('legacy', 2, {});
		h.entries = [forB, legacy];

		await apply(forB);
		expect(outcomeOf('for-b')).toEqual(['skipped:device-changed']);

		await apply(legacy);
		expect(outcomeOf('legacy')).toEqual(['applied']);
	});
});
