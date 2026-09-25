// Reading the sealed vault with no account: the recovering client has a locator
// derived from the reconstructed secret and nothing else. Every negative case
// must be distinguishable — "nothing is stored here" and "the server did not
// answer" lead to opposite next steps for the person recovering.
import { describe, it, expect } from 'vitest';
import { newWrapKey, deriveVaultLocator } from '@/lib/pq/vaultEnvelope';
import { getPublicStorageRowsByUuid } from '@/lib/data/userStorage';

const row = (locator: string, over: Record<string, unknown> = {}) => ({
	value: { uuid: locator, value_b64: 'sealed', owner_timestamp: 1, deleted_flag: false, ...over },
});

/** Runs the read against a stubbed shape endpoint. Returns what came back and
 * the URL that was asked for — no state shared between cases. */
const read = async (locator: string, payload: unknown, status = 200) => {
	const original = globalThis.fetch;
	let url = '';
	globalThis.fetch = (async (requested: string) => {
		url = String(requested);
		return { ok: status === 200, status, json: async () => payload };
	}) as never;
	try {
		return { rows: await getPublicStorageRowsByUuid(locator), url };
	} finally {
		globalThis.fetch = original;
	}
};

describe('finding the vault with nothing but the key', () => {
	const locator = () => deriveVaultLocator(newWrapKey());

	it('returns the row stored at that address', async () => {
		const at = locator();
		const { rows } = await read(at, [row(at)]);
		expect(rows[0].value_b64).toBe('sealed');
	});

	it('returns every candidate, because one address can hold more than one row', async () => {
		// Only half the primary key is known here, so anyone who learns the
		// locator can write their own row at it. Handing back the first match
		// would let that row shadow the real vault; the seal decides which is
		// ours, and nothing else can.
		const at = locator();
		const { rows } = await read(at, [
			row(at, { user_hash: 'u_squatter', value_b64: 'decoy' }),
			row(at, { user_hash: 'u_owner', value_b64: 'sealed' }),
		]);
		expect(rows.map((r) => r.value_b64)).toEqual(['decoy', 'sealed']);
	});

	it('drops a tombstone in every shape the wire uses for a boolean', async () => {
		// No Electric parser runs on this path, so a Postgres bool arrives as
		// true, 't', 1 or '1' depending on the hop. Missing one hands back a
		// vault its owner deliberately revoked.
		for (const flag of [true, 't', 1, '1', 'true']) {
			const at = locator();
			const { rows } = await read(at, [row(at, { deleted_flag: flag })]);
			expect(rows).toEqual([]);
		}
	});

	it('says nothing is stored there when nothing is', async () => {
		const { rows } = await read(locator(), []);
		expect(rows).toEqual([]);
	});

	it('refuses a locator that is not a uuid instead of putting it in a query', async () => {
		await expect(read("x' OR deleted_flag=false OR uuid='", [])).rejects.toThrow(/Invalid user_storage uuid/);
	});

	it('surfaces a failed fetch instead of reporting no backup', async () => {
		await expect(read(locator(), [], 503)).rejects.toThrow(/HTTP 503/);
	});

	it('asks a different question every time, so no answer can be a cached one', async () => {
		// The predicate used to be Date.now() % 100000, which repeats every 100
		// seconds: a screen polling for a row that has not appeared yet would
		// eventually re-ask for the very cached shape it was trying to escape.
		const at = locator();
		const first = (await read(at, [])).url;
		const second = (await read(at, [])).url;
		expect(second).not.toBe(first);
	});

	it('asks for a shape nobody else is subscribed to', async () => {
		// A cached shape with no live subscriber can miss a row committed
		// seconds ago, which is exactly the row recovery is looking for.
		const at = locator();
		const { url } = await read(at, []);
		// A backreference, not two loose numbers: the point is that the two
		// halves are equal, so the predicate is a no-op rather than a filter
		// that matches nothing.
		expect(decodeURIComponent(url)).toMatch(new RegExp(`uuid='${at}' AND (\\d+)=\\1`));
	});
});
