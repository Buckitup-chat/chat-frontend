import { mergeLiveWithCached } from './readCache';
import { readCachedCards } from './userCardsCache';
import { createShapeLink, whenLive } from './shapeLink';
import { verifyUserCard } from '@/lib/pq/verifyCard';
import type { UserCardRow } from './types';

export const userCardsShapeLink = createShapeLink();
const link = userCardsShapeLink;

export const userCardsFetch = link.fetchClient;
export const reportUserCardsStreamError = link.report;
export const onUserCardsStreamError = link.onStreamError;
export const whenUserCardsLive = whenLive;

export async function userCardsWithCache(liveRows: UserCardRow[]): Promise<UserCardRow[]> {
	const cached = await readCachedCards();
	const merged = mergeLiveWithCached('user_cards', liveRows as unknown as Record<string, unknown>[], cached as unknown as Record<string, unknown>[], (r) => String(r.user_hash));
	return verifiedCards(merged as unknown as UserCardRow[]);
}

const checked = new WeakMap<object, { signB64: unknown; ok: boolean }>();

export function verifiedCards(rows: UserCardRow[]): UserCardRow[] {
	return rows.filter((row) => {
		if (!row || typeof row !== 'object') return false;
		const seen = checked.get(row);
		if (seen && seen.signB64 === row.sign_b64) return seen.ok;
		let ok: boolean;
		try {
			ok = verifyUserCard(row).status === 'verified';
		} catch {
			ok = false;
		}
		checked.set(row, { signB64: row.sign_b64, ok });
		return ok;
	});
}
