// The sealed vault and the row it lives in, joined: lib/pq/vaultEnvelope says
// what the bytes are, lib/data/userStorage says where rows go, and this is the
// one place that knows both.
//
// The two directions are asymmetric on purpose. Publishing is done by a
// signed-in account, so it carries the signing key like every other
// user_storage write. Fetching is done by nobody — the account is what is
// being recovered — so it takes the wrap key and nothing else, and reads the
// public shape rather than an account's collection.
import { deriveVaultLocator, sealVault, openVault, VaultEnvelopeError } from '@/lib/pq/vaultEnvelope';
import { putStorageRow, getPublicStorageRowsByUuid } from '@/lib/data/userStorage';
import { parseBackupContents, type BackupContents } from '@/lib/backupContents';

// A stalled /shapes request would otherwise hold the restore screen — and the
// key in memory — until the tab is closed.
const FETCH_TIMEOUT_MS = 20_000;

export class VaultLookupError extends Error {
	/** 'absent': nothing lives at this key's address. 'foreign': rows do, and none of them opens under this key. */
	constructor(message: string, readonly reason: 'absent' | 'foreign') {
		super(message);
	}
}

/**
 * Seals `json` under the wrap key and writes it where the key alone can find
 * it. Resolves to the row's uuid once the server has taken the write: a vault
 * that only exists locally is one the shares would point at in vain.
 */
export const publishVault = async (opts: {
	userHash: string;
	signSkey: Uint8Array;
	wrapKey: Uint8Array;
	json: string;
}): Promise<string> => {
	const uuid = deriveVaultLocator(opts.wrapKey);
	await putStorageRow({
		userHash: opts.userHash,
		uuid,
		valueB64: await sealVault(opts.json, opts.wrapKey),
		hashB64: null,
		signSkey: opts.signSkey,
	});
	return uuid;
};

/**
 * The vault, with nothing but the key. Every live row at the derived address
 * is tried, because anyone who learns the address can write a row there and
 * the seal is the only thing that tells the owner's apart. A transport
 * failure propagates as-is: "the server did not answer" and "nothing is
 * stored" send the person recovering in opposite directions.
 */
export const fetchVault = async (wrapKey: Uint8Array): Promise<BackupContents> => {
	const rows = await getPublicStorageRowsByUuid(deriveVaultLocator(wrapKey), AbortSignal.timeout(FETCH_TIMEOUT_MS));
	if (!rows.length) throw new VaultLookupError('No backup is stored for this key.', 'absent');
	for (const row of rows) {
		if (!row.value_b64) continue;
		let text: string;
		try {
			text = await openVault(row.value_b64, wrapKey);
		} catch (e) {
			if (e instanceof VaultEnvelopeError) continue;
			throw e;
		}
		try {
			return parseBackupContents(JSON.parse(text));
		} catch (e) {
			throw new Error('The vault opened, but it is not an account backup.', { cause: e });
		}
	}
	throw new VaultLookupError('Something is stored at this address, but not under this key.', 'foreign');
};
