import { describe, it, expect, afterEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import { _setStorageForTests } from '@/lib/data/outbox';
import { markUnconfirmed, clearUnconfirmed, StaleBaseError, _resetStaleBase } from '@/lib/data/staleBase';

const MY_HASH = 'u_' + 'a'.repeat(128);

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
_setStorageForTests(makeStorage());

const unmodeledMutation = () => ([{
	type: 'insert',
	modified: { id: '1' },
	syncMetadata: { relation: 'brand_new_relation' },
}]);

const dialogMessage = () => ([{
	type: 'insert',
	modified: { message_id: 'dmsg_1', sender_hash: MY_HASH, dialog_hash: 'dh1', content_b64: 'hi' },
	syncMetadata: { relation: 'dialog_messages' },
}]);

afterEach(() => {
	_resetStaleBase();
});

describe('dependenciesFor refuses a chained write on an unconfirmed scope (§4.6)', () => {
	it('throws for a chained write of the exact scope a shape timeout flagged', async () => {
		markUnconfirmed('brand_new_relation');
		await expect(dependenciesFor(unmodeledMutation(), MY_HASH)).rejects.toThrow(StaleBaseError);
	});

	it('does not affect an unrelated relation/scope', async () => {
		markUnconfirmed('brand_new_relation');
		await expect(dependenciesFor(dialogMessage(), MY_HASH)).resolves.toEqual([]);
	});

	it('stops throwing once the scope catches up', async () => {
		markUnconfirmed('brand_new_relation');
		clearUnconfirmed('brand_new_relation');
		await expect(dependenciesFor(unmodeledMutation(), MY_HASH)).resolves.toEqual([]);
	});
});
