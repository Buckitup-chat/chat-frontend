// The app draws icons from its own masked SVG set (src/scss/icons.scss,
// public/icons). Bootstrap Icons' font is not loaded, so a bi class renders
// an empty box: no source file may use one, statically or in a binding. And
// a class of the set draws nothing unless the set defines it and its mask
// exists.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
	.filter((f) => /\.(vue|js|ts)$/.test(f))
	.map((f) => readFileSync(join('src', f), 'utf8'));

describe('the icon set', () => {
	it('no source file uses a Bootstrap Icons class', () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(sources.filter((s) => /\bbi-[a-z]|class="bi\b|'bi'/.test(s))).toEqual([]);
	});

	it('defines every icon class a source file uses, with its mask', () => {
		const used = new Set(sources.flatMap((s) => [...s.matchAll(/_icon_([a-z0-9_]+)/g)].map((m) => m[1])));
		const set = readFileSync('src/scss/icons.scss', 'utf8');
		const missing = [...used].filter((name) => !set.includes(`'${name}'`) || !existsSync(`public/icons/${name}.svg`));
		expect(used.size).toBeGreaterThan(0);
		expect(missing).toEqual([]);
	});
});
