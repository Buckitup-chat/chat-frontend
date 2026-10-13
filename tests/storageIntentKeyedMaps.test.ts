// A record that keeps entries by id is edited by key when the patch says so
// (`$keyed`), so two writers — another tab, another device — never drop each
// other's entries; a map the patch does not name keyed is replaced as before.
import { describe, it, expect } from 'vitest';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

const land = (base: Record<string, unknown> | null, patch: Record<string, unknown>) =>
	stripPatchDirectives(mergeJsonPatch(base, patch));

describe('mergeJsonPatch: keyed maps', () => {
	it('adds an entry beside those already stored, for whatever map the patch names', () => {
		for (const key of ['invites', 'answers', 'holdings', 'avatars']) {
			expect(land({ [key]: { a: { n: 1 } }, other: 1 }, { $keyed: [key], [key]: { b: { n: 2 } } })).toEqual({ [key]: { a: { n: 1 }, b: { n: 2 } }, other: 1 });
		}
	});

	it('replaces a map the patch does not name keyed', () => {
		expect(land({ holdings: { a: { n: 1 } } }, { holdings: { b: { n: 2 } } })).toEqual({ holdings: { b: { n: 2 } } });
	});

	it('replaces an entry whole, so a field left out is gone', () => {
		const base = { holdings: { k: { state: 'stored', share: { shareB64: 'AAAA' } } } };
		expect(land(base, { $keyed: ['holdings'], holdings: { k: { state: 'dropped', share: {} } } })).toEqual({ holdings: { k: { state: 'dropped', share: {} } } });
	});

	it('deletes an entry named with null, and stores neither null nor the directive', () => {
		expect(land({ invites: { a: { n: 1 }, b: { n: 2 } } }, { $keyed: ['invites'], invites: { a: null } })).toEqual({ invites: { b: { n: 2 } } });
		expect(land(null, { $keyed: ['invites'], invites: { a: null } })).toEqual({ invites: {} });
	});

	it('keeps both edits, the deletion included, when two pending patches coalesce', () => {
		const pending = mergeJsonPatch({ $keyed: ['answers'], answers: { a: null } }, { $keyed: ['holdings'], holdings: { h: { n: 4 } } });
		const both = mergeJsonPatch(pending, { $keyed: ['answers'], answers: { c: { n: 3 } } });
		expect(land({ answers: { a: { n: 1 }, b: { n: 2 } }, holdings: { g: { n: 5 } } }, both)).toEqual({
			answers: { b: { n: 2 }, c: { n: 3 } },
			holdings: { g: { n: 5 }, h: { n: 4 } },
		});
	});
});
