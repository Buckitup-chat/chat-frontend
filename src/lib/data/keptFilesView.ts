import type { KeptFile } from './keptFiles';

export type KeptCategory = 'image' | 'video' | 'audio' | 'file';
export type KeptPeriod = 'week' | 'month' | 'older';
export type KeptSort = 'newest' | 'oldest' | 'largest' | 'smallest';

export interface KeptFilter {
	text?: string;
	chat?: string;
	category?: KeptCategory | '';
	period?: KeptPeriod | '';
	sort?: KeptSort;
}

export const UNKNOWN_CHAT = 'unknown';

const DAY = 86_400;

export const categoryOf = (f: Pick<KeptFile, 'kind' | 'mimeType'>): KeptCategory => {
	if (f.kind === 'image' || f.kind === 'video') return f.kind;
	if (f.mimeType?.startsWith('audio/')) return 'audio';
	return 'file';
};

export const chatOf = (f: Pick<KeptFile, 'peerHash'>): string => f.peerHash || UNKNOWN_CHAT;

export const keptChats = (files: KeptFile[]): string[] => [...new Set(files.map(chatOf))];

const inPeriod = (createdAt: number, period: KeptPeriod, now: number): boolean => {
	if (period === 'week') return createdAt >= now - 7 * DAY;
	if (period === 'month') return createdAt >= now - 30 * DAY;
	return createdAt < now - 30 * DAY;
};

const ORDER: Record<KeptSort, (a: KeptFile, b: KeptFile) => number> = {
	newest: (a, b) => b.createdAt - a.createdAt,
	oldest: (a, b) => a.createdAt - b.createdAt,
	largest: (a, b) => b.size - a.size,
	smallest: (a, b) => a.size - b.size,
};

export const filterKeptFiles = (files: KeptFile[], filter: KeptFilter, now: number = Math.floor(Date.now() / 1000)): KeptFile[] => {
	const text = filter.text?.trim().toLowerCase() ?? '';
	return files
		.filter((f) => !text || f.name.toLowerCase().includes(text))
		.filter((f) => !filter.chat || chatOf(f) === filter.chat)
		.filter((f) => !filter.category || categoryOf(f) === filter.category)
		.filter((f) => !filter.period || inPeriod(f.createdAt, filter.period, now))
		.sort(ORDER[filter.sort ?? 'newest']);
};
