// Resolves named user_storage slots to their addresses.
//
// Only the root record has a derivable address (see lib/pq/slotId). Every
// other slot gets a random uuid when first created and is reachable only
// through the `slots` map stored inside the root record — so a stranger who
// knows a user_hash cannot guess where anything lives.
//
// The root record is encrypted, and the key lives in EncryptionManagerPQ, so
// this module does not touch crypto: the caller supplies read/write access to
// the already-decrypted root object and keeps the resolver testable on its own.

/** Decrypted root record: today's profile fields plus the slot map. */
export interface RootRecord {
	slots?: Record<string, string>;
	[key: string]: unknown;
}

export interface RootAccess {
	/** Decrypted root record, or null when the account has none yet. */
	read(): Promise<RootRecord | null>;
	/** Persists the root record and waits for the write to be durable. */
	write(next: RootRecord): Promise<void>;
}

export class SlotMapError extends Error {}

export function createSlotResolver(access: RootAccess) {
	// One session-lived cache. Slot addresses never change for an account, but
	// the map must be re-read after logout so another account cannot inherit it.
	let cached: Record<string, string> | null = null;
	// Serializes creation so two concurrent callers cannot each mint a uuid.
	let pending: Promise<unknown> = Promise.resolve();

	const loadMap = async (): Promise<Record<string, string>> => {
		if (cached) return cached;
		const root = await access.read();
		// A root record that exists without a slots map is a valid starting
		// state (the profile was written before any slot was created).
		cached = root?.slots ?? {};
		return cached;
	};

	const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = pending.then(fn, fn);
		pending = run.catch(() => undefined);
		return run;
	};

	/** Address of an existing slot, or null when it has never been created. */
	const getSlotUuid = async (name: string): Promise<string | null> => {
		const map = await loadMap();
		return map[name] ?? null;
	};

	/**
	 * Address of a slot, creating it on first use.
	 *
	 * Two tabs can reach this at the same moment and both see the slot
	 * missing. Writes are serialized in-process, but a second tab is a
	 * separate process: after writing we re-read the map, and if another
	 * writer won we adopt their uuid and report ours as orphaned rather than
	 * letting the two tabs address different rows.
	 */
	const ensureSlotUuid = async (
		name: string,
		mintUuid: () => string,
	): Promise<{ uuid: string; created: boolean; orphaned?: string }> =>
		serialize(async () => {
			const existing = (await loadMap())[name];
			if (existing) return { uuid: existing, created: false };

			const root = (await access.read()) ?? {};
			const beforeWrite = root.slots?.[name];
			if (beforeWrite) {
				cached = root.slots ?? {};
				return { uuid: beforeWrite, created: false };
			}

			const uuid = mintUuid();
			const nextSlots = { ...(root.slots ?? {}), [name]: uuid };
			await access.write({ ...root, slots: nextSlots });
			cached = nextSlots;

			// Re-read through the write barrier: another tab may have committed
			// its own uuid for this name in the meantime.
			const confirmed = (await access.read())?.slots?.[name];
			if (confirmed && confirmed !== uuid) {
				cached = { ...nextSlots, [name]: confirmed };
				return { uuid: confirmed, created: false, orphaned: uuid };
			}
			return { uuid, created: true };
		});

	/**
	 * Address of a slot the caller knows must already exist.
	 *
	 * Never creates on miss: silently minting a replacement for a slot that
	 * the map says should be there would abandon the data behind it — the
	 * user's contacts — with no way back. The caller decides what to do.
	 */
	const requireSlotUuid = async (name: string): Promise<string> => {
		const uuid = await getSlotUuid(name);
		if (!uuid) throw new SlotMapError(`user_storage slot "${name}" is missing from the root record`);
		return uuid;
	};

	/** Drops the cache; call on logout so the next account re-reads its own map. */
	const reset = () => {
		cached = null;
	};

	return { getSlotUuid, ensureSlotUuid, requireSlotUuid, reset };
}
