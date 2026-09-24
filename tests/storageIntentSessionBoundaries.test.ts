import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startLeaderElection, stopLeaderElection, currentSessionToken, SessionFencedError } from '@/lib/data/outbox';
import { pinActiveSession } from '@/lib/data/sessionGuard';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const ROOT_UUID = 'root-0000-0000-0000-000000000000';

const collection = { rows: new Map<string, unknown>(), async preload() {}, get: (k: string) => collection.rows.get(k) };
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const { materializeStorageIntent, setStorageJsonCodec } = await import('@/lib/data/storageIntent');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setStorageForTests: setOutboxStorage } = await import('@/lib/data/outbox');

let releaseEncrypt: (() => void) | null = null;
let encryptDeferred = false;
let encryptCalls = 0;

beforeEach(() => {
	collection.rows.clear();
	setOutboxStorage(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
	encryptDeferred = false;
	encryptCalls = 0;
	releaseEncrypt = null;
	setStorageJsonCodec({
		decrypt: async (valueB64: string) => JSON.parse(valueB64),
		encrypt: async (value: Record<string, unknown>) => {
			encryptCalls++;
			if (encryptDeferred) await new Promise<void>((resolve) => { releaseEncrypt = resolve; });
			return { valueB64: JSON.stringify(value), hashB64: null };
		},
	});
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
});

afterEach(() => {
	setStorageJsonCodec(null);
	stopLeaderElection();
});

describe('materializeStorageIntent: a session switch during the jsonPatch merge is caught before signing (§ account isolation)', () => {
	it('a switch strictly between decrypt and encrypt is rejected, never returning a ready row built from the wrong account\'s codec window', async () => {
		collection.rows.set(`${MY_HASH}|${ROOT_UUID}`, {
			user_hash: MY_HASH, uuid: ROOT_UUID, value_b64: JSON.stringify({ slots: { alpha: 'A0' } }),
			deleted_flag: false, parent_sign_hash: null, sign_hash: 'server-h10', owner_timestamp: 1000, sign_b64: 'sig',
		});
		encryptDeferred = true;
		const token = pinActiveSession(MY_HASH, 'test:start');

		const call = materializeStorageIntent(
			{ kind: 'storage', relation: 'user_storage', userHash: MY_HASH, uuid: ROOT_UUID, deletedFlag: false, valueB64: '', jsonPatch: { slots: { beta: 'B1' } }, revision: 0 },
			token
		);

		await vi.waitFor(() => expect(encryptCalls).toBe(1));
		stopLeaderElection();
		startLeaderElection(OTHER_HASH, () => {});
		releaseEncrypt?.();

		await expect(call).rejects.toThrow(SessionFencedError);
	});

	it('with no switch at all, the same merge completes normally', async () => {
		collection.rows.set(`${MY_HASH}|${ROOT_UUID}`, {
			user_hash: MY_HASH, uuid: ROOT_UUID, value_b64: JSON.stringify({ slots: { alpha: 'A0' } }),
			deleted_flag: false, parent_sign_hash: null, sign_hash: 'server-h10', owner_timestamp: 1000, sign_b64: 'sig',
		});
		const token = pinActiveSession(MY_HASH, 'test:start');

		const ready = await materializeStorageIntent(
			{ kind: 'storage', relation: 'user_storage', userHash: MY_HASH, uuid: ROOT_UUID, deletedFlag: false, valueB64: '', jsonPatch: { slots: { beta: 'B1' } }, revision: 0 },
			token
		);

		expect(JSON.parse(ready.row.value_b64 as string).slots).toEqual({ alpha: 'A0', beta: 'B1' });
		expect(currentSessionToken()).toEqual(token);
	});
});
