// The app draws icons from its own masked SVG set (src/scss/icons.scss,
// public/icons). Bootstrap Icons' font is not loaded, so a bi class renders
// an empty box: no source file may use one, statically or in a binding.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('the icon set', () => {
	it('no source file uses a Bootstrap Icons class', () => {
		const files = execSync("git ls-files 'src/*.vue' 'src/*.js' 'src/*.ts'", { encoding: 'utf8' }).split('\n').filter(Boolean);
		const offenders = files.filter((f) => /\bbi-[a-z]|class="bi\b|'bi'/.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});

	it('defines every icon class a source file uses, with its mask', () => {
		const files = execSync("git ls-files 'src/*.vue' 'src/*.js' 'src/*.ts'", { encoding: 'utf8' }).split('\n').filter(Boolean);
		const used = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/_icon_([a-z0-9_]+)/g)].map((m) => m[1])));
		const set = readFileSync('src/scss/icons.scss', 'utf8');
		const missing = [...used].filter((name) => !set.includes(`'${name}'`) || !existsSync(`public/icons/${name}.svg`));
		expect(used.size).toBeGreaterThan(0);
		expect(missing).toEqual([]);
	});
});
