// The recovery slots keep records by id; a patch edits them by key, so two
// writers — another tab, another device — never drop each other's entries.
import { describe, it, expect } from 'vitest';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

const land = (base: Record<string, unknown> | null, patch: Record<string, unknown>) =>
	stripPatchDirectives(mergeJsonPatch(base, patch));

describe('mergeJsonPatch: keyed maps of the recovery slots', () => {
	it('adds an entry beside those already stored', () => {
		for (const key of ['invites', 'answers', 'holdings']) {
			expect(land({ [key]: { a: { n: 1 } }, other: 1 }, { [key]: { b: { n: 2 } } })).toEqual({ [key]: { a: { n: 1 }, b: { n: 2 } }, other: 1 });
		}
	});

	it('replaces an entry whole, so a field left out is gone', () => {
		const base = { holdings: { k: { state: 'stored', share: { shareB64: 'AAAA' } } } };
		expect(land(base, { holdings: { k: { state: 'dropped', share: {} } } })).toEqual({ holdings: { k: { state: 'dropped', share: {} } } });
	});

	it('deletes an entry named with null, and stores no null', () => {
		expect(land({ invites: { a: { n: 1 }, b: { n: 2 } } }, { invites: { a: null } })).toEqual({ invites: { b: { n: 2 } } });
		expect(land(null, { invites: { a: null } })).toEqual({ invites: {} });
	});

	it('keeps both edits, the deletion included, when two pending patches coalesce', () => {
		const pending = mergeJsonPatch({ answers: { a: null } }, { answers: { c: { n: 3 } } });
		expect(land({ answers: { a: { n: 1 }, b: { n: 2 } } }, pending)).toEqual({ answers: { b: { n: 2 }, c: { n: 3 } } });
	});
});
