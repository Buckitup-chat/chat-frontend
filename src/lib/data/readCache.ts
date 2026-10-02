const cacheKey = (table: string, key: string): string => `${table}:${key}`;

const touchedKeys = new Set<string>();

export function markTouched(table: string, key: string): void {
	touchedKeys.add(cacheKey(table, key));
}

export function isTouched(table: string, key: string): boolean {
	return touchedKeys.has(cacheKey(table, key));
}

export function _resetTouchedForTests(): void {
	touchedKeys.clear();
}

export function mergeLiveWithCached<T extends Record<string, unknown>>(
	table: string,
	liveRows: T[],
	cachedRows: T[],
	getRowKey: (row: T) => string
): T[] {
	const liveKeys = new Set(liveRows.map(getRowKey));
	const fromCache = cachedRows.filter((row) => {
		const key = getRowKey(row);
		return !liveKeys.has(key) && !isTouched(table, key);
	});
	return [...fromCache, ...liveRows];
}

export async function clearReadCache(opts: { keep?: string[] } = {}): Promise<void> {
	const keep = opts.keep ?? [];
	const isKept = (fullKey: string) => keep.some((table) => fullKey.startsWith(`${table}:`));
	for (const key of [...touchedKeys]) {
		if (!isKept(key)) touchedKeys.delete(key);
	}
}
