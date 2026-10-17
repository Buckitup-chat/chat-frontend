// The app draws icons from its own masked SVG set (src/scss/icons.scss,
// public/icons). Bootstrap Icons' font is not loaded, so a bi class renders
// an empty box: no source file may use one, statically or in a binding.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('the icon set', () => {
	it('no source file uses a Bootstrap Icons class', () => {
		const files = execSync("git ls-files 'src/*.vue' 'src/*.js' 'src/*.ts'", { encoding: 'utf8' }).split('\n').filter(Boolean);
		const offenders = files.filter((f) => /\bbi-[a-z]|class="bi\b|'bi'/.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});
});
