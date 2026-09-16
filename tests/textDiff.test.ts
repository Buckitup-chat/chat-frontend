import { describe, it, expect } from 'vitest';
import { diffWords } from '@/lib/data/textDiff';

// Screen 06 highlights the change INSIDE the text — the board's example is
// a meeting time moved from 19:00 to 19:30.
describe('word diff', () => {
	it('marks the changed word and keeps the rest', () => {
		const parts = diffWords('Встречаемся у второго узла в 19:00', 'Встречаемся у второго узла в 19:30');
		expect(parts.filter((p) => p.kind === 'added').map((p) => p.text)).toEqual(['19:30']);
		expect(parts.filter((p) => p.kind === 'removed').map((p) => p.text)).toEqual(['19:00']);
		expect(parts.filter((p) => p.kind === 'same').map((p) => p.text).join('')).toContain('Встречаемся у второго узла в');
	});

	it('handles pure additions and pure removals', () => {
		expect(diffWords('a b', 'a b c').filter((p) => p.kind === 'added').map((p) => p.text).join('')).toBe(' c');
		expect(diffWords('a b c', 'a b').filter((p) => p.kind === 'removed').map((p) => p.text).join('')).toBe(' c');
	});

	it('returns one same-run for identical texts', () => {
		expect(diffWords('привет мир', 'привет мир')).toEqual([{ text: 'привет мир', kind: 'same' }]);
	});

	it('merges adjacent parts of one kind', () => {
		const parts = diffWords('x', 'совсем другой текст');
		expect(parts.filter((p) => p.kind === 'added')).toHaveLength(1);
	});
});
