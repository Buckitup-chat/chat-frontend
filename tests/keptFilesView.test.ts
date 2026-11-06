import { describe, it, expect } from 'vitest';
import type { KeptFile } from '@/lib/data/keptFiles';
import { categoryOf, chatOf, filterKeptFiles, keptChats, UNKNOWN_CHAT } from '@/lib/data/keptFilesView';

const DAY = 86_400;
const NOW = 1_800_000_000;
const PEER_A = 'u_' + 'a'.repeat(128);
const PEER_B = 'u_' + 'b'.repeat(128);

const entry = (over: Partial<KeptFile>): KeptFile => ({
	fileKey: `${PEER_A}/${over.fileId ?? 'f_1'}`,
	fileId: 'f_1',
	uploaderHash: PEER_A,
	encSecretB64: 'c2VjcmV0',
	kind: 'file',
	name: 'report.pdf',
	size: 100,
	mimeType: 'application/pdf',
	createdAt: NOW - DAY,
	messageId: 'dmsg_1',
	chunkHashes: ['fd_1'],
	peerHash: PEER_A,
	...over,
});

const files = [
	entry({ fileId: 'f_1', name: 'Report Q3.pdf', size: 300, createdAt: NOW - 2 * DAY }),
	entry({ fileId: 'f_2', name: 'beach.jpg', kind: 'image', mimeType: 'image/jpeg', size: 900, createdAt: NOW - 20 * DAY, peerHash: PEER_B }),
	entry({ fileId: 'f_3', name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', size: 5000, createdAt: NOW - 60 * DAY }),
	entry({ fileId: 'f_4', name: 'voice.mp3', mimeType: 'audio/mpeg', size: 50, createdAt: NOW - 1 * DAY, peerHash: PEER_B }),
];
const ids = (list: KeptFile[]) => list.map((f) => f.fileId);

describe('the kept files list', () => {
	it('tells images, videos, audio and other files apart', () => {
		expect(files.map(categoryOf)).toEqual(['file', 'image', 'video', 'audio']);
	});

	it('searches by name, ignoring case', () => {
		expect(ids(filterKeptFiles(files, { text: 'report' }, NOW))).toEqual(['f_1']);
		expect(ids(filterKeptFiles(files, { text: '.MP' }, NOW)).sort()).toEqual(['f_3', 'f_4']);
	});

	it('filters by chat, by type and by date', () => {
		expect(ids(filterKeptFiles(files, { chat: PEER_B }, NOW)).sort()).toEqual(['f_2', 'f_4']);
		expect(ids(filterKeptFiles(files, { category: 'video' }, NOW))).toEqual(['f_3']);
		expect(ids(filterKeptFiles(files, { period: 'week' }, NOW)).sort()).toEqual(['f_1', 'f_4']);
		expect(ids(filterKeptFiles(files, { period: 'month' }, NOW)).sort()).toEqual(['f_1', 'f_2', 'f_4']);
		expect(ids(filterKeptFiles(files, { period: 'older' }, NOW))).toEqual(['f_3']);
		expect(ids(filterKeptFiles(files, { chat: PEER_B, category: 'audio', text: 'voice' }, NOW))).toEqual(['f_4']);
	});

	it('sorts by date and by size, newest first by default', () => {
		expect(ids(filterKeptFiles(files, {}, NOW))).toEqual(['f_4', 'f_1', 'f_2', 'f_3']);
		expect(ids(filterKeptFiles(files, { sort: 'oldest' }, NOW))).toEqual(['f_3', 'f_2', 'f_1', 'f_4']);
		expect(ids(filterKeptFiles(files, { sort: 'largest' }, NOW))).toEqual(['f_3', 'f_2', 'f_1', 'f_4']);
		expect(ids(filterKeptFiles(files, { sort: 'smallest' }, NOW))).toEqual(['f_4', 'f_1', 'f_2', 'f_3']);
	});

	it('lists each chat once', () => {
		expect(keptChats(files).sort()).toEqual([PEER_A, PEER_B].sort());
	});

	it('keeps an entry kept before the index named its chat, under an unknown chat', () => {
		const old = entry({ fileId: 'f_9', peerHash: undefined });
		expect(chatOf(old)).toBe(UNKNOWN_CHAT);
		expect(keptChats([old])).toEqual([UNKNOWN_CHAT]);
		expect(ids(filterKeptFiles([old, ...files], { chat: UNKNOWN_CHAT }, NOW))).toEqual(['f_9']);
	});
});
