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
	const liveKeys = new Set(liveRows.map((r) => r.user_hash));
	const cached = await readCachedCards();
	const merged = mergeLiveWithCached('user_cards', liveRows as unknown as Record<string, unknown>[], cached as unknown as Record<string, unknown>[], (r) => String(r.user_hash));
	return (merged as unknown as UserCardRow[]).filter((r) => liveKeys.has(r.user_hash) || isVerifiedCard(r));
}

function isVerifiedCard(row: UserCardRow): boolean {
	try {
		return verifyUserCard(row).status === 'verified';
	} catch {
		return false;
	}
}
