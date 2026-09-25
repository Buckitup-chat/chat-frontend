// The vault's round trip through user_storage: published by an account,
// found by a key. The store underneath is a fake that keeps the contract the
// real one has — rows keyed by (user_hash, uuid), a public read by uuid that
// returns every live row at that address, a write that fails when the server
// did not take it — so what is exercised is the joining logic and not a lie
// about the transport.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { newWrapKey, deriveVaultLocator, sealVault } from '@/lib/pq/vaultEnvelope';
import { BackupFormatError } from '@/lib/backupCrypto';
import { splitWrapKey, restoreFromShares } from '@/lib/wrapKeyShares';

interface Row {
	user_hash: string;
	uuid: string;
	value_b64: string | null;
	deleted_flag: boolean;
}

let table: Map<string, Row>;
let serverAccepts: boolean;
let serverAnswers: boolean;

vi.mock('@/lib/data/userStorage', () => ({
	putStorageRow: async (opts: { userHash: string; uuid: string; valueB64: string; deletedFlag?: boolean }) => {
		if (!serverAccepts) throw new Error('Saved on this device, but the server did not take it');
		const row: Row = {
			user_hash: opts.userHash,
			uuid: opts.uuid,
			value_b64: opts.valueB64,
			deleted_flag: opts.deletedFlag ?? false,
		};
		table.set(`${opts.userHash}|${opts.uuid}`, row);
		return row;
	},
	getPublicStorageRowsByUuid: async (uuid: string) => {
		if (!serverAnswers) throw new Error('user_storage read failed: HTTP 503');
		return [...table.values()].filter((r) => r.uuid === uuid && !r.deleted_flag);
	},
}));

import { publishVault, fetchVault, VaultLookupError } from '@/lib/recovery/vault';

const OWNER = 'u_owner';
const SIGN_SKEY = new Uint8Array(32).fill(7);
const BACKUP = JSON.stringify({ version: 1, identity: { user_hash: OWNER, name: 'Owner' }, keys: { sign_skey: 'x' } });

const publish = (wrapKey: Uint8Array, json = BACKUP) =>
	publishVault({ userHash: OWNER, signSkey: SIGN_SKEY, wrapKey, json });

const squat = (uuid: string, value_b64: string, who = 'u_squatter') => {
	table.set(`${who}|${uuid}`, { user_hash: who, uuid, value_b64, deleted_flag: false });
};

beforeEach(() => {
	table = new Map();
	serverAccepts = true;
	serverAnswers = true;
});

describe('the vault, published by an account and found by a key', () => {
	it('comes back with nothing but the key', async () => {
		const s = newWrapKey();
		await publish(s);
		const { identity, keys } = await fetchVault(s);
		expect(identity.user_hash).toBe(OWNER);
		expect(keys).toEqual({ sign_skey: 'x' });
	});

	it('lives at the address the key derives, signed by the owner, and not in the clear', async () => {
		const s = newWrapKey();
		const uuid = await publish(s);
		expect(uuid).toBe(deriveVaultLocator(s));
		const row = table.get(`${OWNER}|${uuid}`)!;
		expect(row.value_b64).not.toContain(OWNER);
		expect(row.value_b64).not.toContain('sign_skey');
	});

	it('is absent for a key nothing was published under', async () => {
		await publish(newWrapKey());
		await expect(fetchVault(newWrapKey())).rejects.toMatchObject({ reason: 'absent' });
	});

	it('is not hidden by rows others wrote at the same address', async () => {
		// The address is half the primary key, so anyone who learns it can
		// write there. Rows that are not sealed at all, and rows sealed under
		// some other key, are both skipped on the way to the owner's.
		const s = newWrapKey();
		const uuid = deriveVaultLocator(s);
		squat(uuid, 'AAAA');
		squat(uuid, await sealVault('{}', newWrapKey()), 'u_other');
		await publish(s);
		expect((await fetchVault(s)).identity.user_hash).toBe(OWNER);
	});

	it('says so when the address is occupied but nothing there opens under the key', async () => {
		const s = newWrapKey();
		squat(deriveVaultLocator(s), await sealVault('{}', newWrapKey()));
		await expect(fetchVault(s)).rejects.toMatchObject({ reason: 'foreign' });
	});

	it('refuses a row that opens but is not an account backup', async () => {
		const s = newWrapKey();
		await publish(s, '{"hello":1}');
		await expect(fetchVault(s)).rejects.toThrow(/not an account backup/);
	});

	it('is not a backup until the server has it', async () => {
		serverAccepts = false;
		const s = newWrapKey();
		await expect(publish(s)).rejects.toThrow(/server did not take it/);
		await expect(fetchVault(s)).rejects.toBeInstanceOf(VaultLookupError);
	});

	it('comes back from any k of the shares the key was split into', async () => {
		const s = newWrapKey();
		await publish(s);
		const shares = splitWrapKey(s, 5, 3);
		expect((await restoreFromShares([shares[3], shares[0], shares[4]])).identity.user_hash).toBe(OWNER);
	});

	it('refuses shares that do not combine before asking the server anything', async () => {
		serverAnswers = false;
		const [a] = splitWrapKey(newWrapKey(), 3, 2);
		const [, b] = splitWrapKey(newWrapKey(), 3, 2);
		await expect(restoreFromShares([a, b])).rejects.toBeInstanceOf(BackupFormatError);
	});

	it('lets a transport failure through untouched', async () => {
		// "Nothing is stored" and "the server did not answer" are different
		// answers; turning the second into the first would send the person
		// recovering off to look for shares that would not help.
		serverAnswers = false;
		await expect(fetchVault(newWrapKey())).rejects.toThrow(/HTTP 503/);
	});
});
