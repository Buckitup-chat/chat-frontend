// The recovery-vault list in the root record is merged, never overwritten: a
// vault that falls off it stays live and keeps an old set of shares working.
import { describe, it, expect } from 'vitest';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

const land = (base: Record<string, unknown> | null, patch: Record<string, unknown>) =>
	stripPatchDirectives(mergeJsonPatch(base, patch));

describe('mergeJsonPatch: recovery vault list', () => {
	it('moves the vault a new one replaces onto staleVaults', () => {
		expect(land({ vaultUuid: 'v1', staleVaults: [] }, { vaultUuid: 'v2' }))
			.toMatchObject({ vaultUuid: 'v2', staleVaults: ['v1'] });
	});

	// Another device published v2 after we read the root (vaultUuid v1) and
	// before our v3 landed: v2 must not vanish from the list.
	it('keeps a vault another device published between our read and our write', () => {
		const base = { vaultUuid: 'v2', staleVaults: ['v1'] };
		expect(land(base, { vaultUuid: 'v3' })).toMatchObject({ vaultUuid: 'v3', staleVaults: ['v1', 'v2'] });
	});

	it('removes only the vaults a patch names as retired', () => {
		const out = land({ vaultUuid: 'v3', staleVaults: ['v1', 'v2'] }, { retiredVaults: ['v1'] });
		expect(out).toEqual({ vaultUuid: 'v3', staleVaults: ['v2'] });
	});

	it('keeps both directives when two pending patches coalesce', () => {
		const pending = mergeJsonPatch({ retiredVaults: ['v1'] }, { vaultUuid: 'v4' });
		expect(land({ vaultUuid: 'v3', staleVaults: ['v1', 'v2'] }, pending))
			.toEqual({ vaultUuid: 'v4', staleVaults: ['v2', 'v3'] });
	});

	it('leaves records without a vault untouched', () => {
		expect(land({ name: 'A', slots: { c: 'x' } }, { name: 'B' })).toEqual({ name: 'B', slots: { c: 'x' } });
	});
});
