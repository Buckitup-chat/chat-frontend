// One-shot reads of an Electric shape.
//
// Distinct from the collections in ./collections: those subscribe and stay
// live. These answer a single question at a point in time — which chunks does
// the device already hold, is there a vault at this locator — and there is
// nobody to keep the subscription for afterwards.

import { bearerFor, handleShapeAuth401 } from './readSession';
import { transport } from './transport';

/** Absolute URL for an Electric path, tolerating a relative base (a dev server proxying `/api`). */
export const electricUrl = (path: string): string => transport.url(path);

/**
 * Snapshot of every row matching `where`, unwrapped out of the shape log. The
 * transport reads it under a fresh where (@buckitup/pq-client/transport,
 * freshWhere): a re-read of a cached shape nobody subscribes to can miss rows
 * committed seconds earlier. In trust mode a refused read opens the shape's
 * session and reads once more.
 */
export const readShapeOnce = async <T>(table: string, where: string, signal?: AbortSignal): Promise<T[]> => {
	const read = () => transport.readShapeOnce<T>(table, where, { signal, authorization: bearerFor(table) || undefined });
	let res = await read();
	if (res.kind === 'read_session_required'
		&& await handleShapeAuth401({ error: 'read_session_required', shape: res.shape }, table)) {
		res = await read();
	}
	if (res.kind === 'rows') return res.rows;
	throw new Error(`${table} read failed: HTTP ${res.kind === 'failed' ? res.status : 401}`);
};
