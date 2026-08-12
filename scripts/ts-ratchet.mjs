#!/usr/bin/env node
// TypeScript migration ratchet.
//
// Counts how much of src/ is still untyped and compares it against the
// committed baseline in ts-ratchet.json. The counts may only go DOWN:
// a change that adds untyped files fails, a change that removes them
// prints the command to lower the baseline.
//
// Usage:
//   node scripts/ts-ratchet.mjs            # check against baseline (CI)
//   node scripts/ts-ratchet.mjs --update   # write current counts as baseline
//   node scripts/ts-ratchet.mjs --list     # show which files still count
//
// Why file counts and not `tsc` error counts: the tsconfig/typecheck gate is
// owned separately (branch chore/add-typescript). This ratchet is orthogonal —
// it tracks migration progress and blocks new .js regardless of whether the
// typecheck gate is wired up yet. Once typecheck runs in CI, the two together
// give the full guarantee: no new untyped files, no type errors.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'ts-ratchet.json');

/** Directories never worth counting. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'assets', 'scss']);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (!SKIP_DIRS.has(entry)) walk(full, out);
		} else {
			out.push(full);
		}
	}
	return out;
}

function collect() {
	const jsFiles = [];
	const untypedVue = [];

	for (const file of walk(SRC)) {
		const rel = relative(ROOT, file);
		if (file.endsWith('.js')) {
			jsFiles.push(rel);
		} else if (file.endsWith('.vue')) {
			const source = readFileSync(file, 'utf8');
			// <script setup lang="ts"> / <script lang='ts'> in any attribute order
			const hasTs = /<script[^>]*\blang\s*=\s*["']ts["']/.test(source);
			if (!hasTs) untypedVue.push(rel);
		}
	}

	jsFiles.sort();
	untypedVue.sort();
	return { jsFiles, untypedVue };
}

const { jsFiles, untypedVue } = collect();
const current = { jsFiles: jsFiles.length, untypedVueFiles: untypedVue.length };

if (process.argv.includes('--list')) {
	console.log(`Untyped .js (${current.jsFiles}):`);
	for (const f of jsFiles) console.log(`  ${f}`);
	console.log(`\n.vue without lang="ts" (${current.untypedVueFiles}):`);
	for (const f of untypedVue) console.log(`  ${f}`);
	process.exit(0);
}

if (process.argv.includes('--update')) {
	const next = {
		_comment:
			'TypeScript migration ratchet baseline. These counts may only decrease. ' +
			'Run `npm run ratchet:update` after converting files, and commit this file. ' +
			'See docs/typescript-guidelines.md.',
		...current,
	};
	writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
	console.log(`Baseline written: ${current.jsFiles} .js, ${current.untypedVueFiles} untyped .vue`);
	process.exit(0);
}

let baseline;
try {
	baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
	console.error(
		`No baseline at ${relative(ROOT, BASELINE_PATH)}.\n` +
			`Create it with: npm run ratchet:update`
	);
	process.exit(1);
}

const checks = [
	{ key: 'jsFiles', label: 'untyped .js files' },
	{ key: 'untypedVueFiles', label: '.vue files without lang="ts"' },
];

let failed = false;
let improved = false;

for (const { key, label } of checks) {
	const was = baseline[key];
	const now = current[key];
	if (typeof was !== 'number') {
		console.error(`Baseline is missing "${key}" — run: npm run ratchet:update`);
		process.exit(1);
	}
	if (now > was) {
		failed = true;
		console.error(`FAIL  ${label}: ${now} (baseline ${was}, +${now - was})`);
	} else if (now < was) {
		improved = true;
		console.log(`GOOD  ${label}: ${now} (baseline ${was}, -${was - now})`);
	} else {
		console.log(`OK    ${label}: ${now}`);
	}
}

if (failed) {
	console.error(
		`\nThe TypeScript ratchet only turns one way: untyped files may not increase.\n` +
			`New code must be .ts (or <script setup lang="ts">).\n` +
			`See which files count:  node scripts/ts-ratchet.mjs --list\n` +
			`Guidelines:             docs/typescript-guidelines.md`
	);
	process.exit(1);
}

if (improved) {
	console.log(
		`\nProgress! Lower the baseline so it cannot regress:\n` +
			`  npm run ratchet:update  &&  git add ts-ratchet.json`
	);
	process.exit(1);
}

console.log('\nRatchet holds.');
