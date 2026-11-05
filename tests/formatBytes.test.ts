// Byte counts as the app shows them: storage figures (the storage status
// screen), and the one size format of the chat's file rows, transfer panel,
// file state screen and account deletion dialog (design board §1.5).
import { describe, expect, it } from 'vitest';
import { fileSize, formatBytes } from '@/utils/formatBytes';

describe('storage figures', () => {
	it('formats sizes for people', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(120 * 1024 ** 2)).toBe('120 MB');
		expect(formatBytes(64 * 1024 ** 3)).toBe('64 GB');
		expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
		expect(formatBytes(1023)).toBe('1023 B');
	});
});

describe('file size', () => {
	it('words bytes, kilobytes, megabytes and gigabytes the way the board does', () => {
		expect(fileSize(512)).toBe('512 B');
		expect(fileSize(2048)).toBe('2 KB');
		expect(fileSize(61.7 * 1024 ** 2)).toBe('61.7 MB');
		expect(fileSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
	});

	it('moves on to the next unit where rounding would print 1024', () => {
		expect(fileSize(1023.7 * 1024)).toBe('1.0 MB');
		expect(fileSize(1023.97 * 1024 ** 2)).toBe('1.0 GB');
	});
});
