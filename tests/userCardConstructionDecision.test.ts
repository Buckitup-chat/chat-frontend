import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestIdentity, resignedCard } from './helpers/signedFixtures';

const ME = makeTestIdentity(1, 'Me');
const USER = ME.userHash;
const OTHER = 'u_' + 'b'.repeat(128);

interface FakeShape {
	rows: Map<string, unknown>;
	preload: () => Promise<void>;
	get: (k: string) => unknown;
	utils: { awaitMatch: (fn: (m: unknown) => boolean) => Promise<boolean> };
	goLive: () => void;
	fail: () => void;
}
let shape: FakeShape;
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => shape,
}));

const { createShapeLink, registerShapeLink, whenLive } = await import('@/lib/data/shapeLink');
const {
	decideCardConstruction, storeCardIntentUnderLock, withCardLock, BOOTSTRAP_CARD_PURPOSE,
} = await import('@/lib/data/userCardIntent');
const { enqueueIntent, resolveIntent, _setIntentStorageForTests } = await import('@/lib/data/intents');
const { _setStorageForTests, enqueue, markServerAccepted, recordFailure } = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { VaultLockedError } = await import('@/lib/data/keyCustody');
const { DecryptFailedError } = await import('@/lib/data/secureStore');
const { IngestError } = await import('@/lib/data/ingest');

const makeShape = (): FakeShape => {
	const rows = new Map<string, unknown>();
	const matchers = new Set<{ fn: (m: unknown) => boolean; resolve: (v: boolean) => void }>();
	const link = createShapeLink();
	const fake: FakeShape = {
		rows, preload: async () => {}, get: (k) => rows.get(k),
		utils: { awaitMatch: (fn) => new Promise<boolean>((resolve) => matchers.add({ fn, resolve })) },
		goLive: () => {
			for (const m of [...matchers]) if (m.fn({ headers: { control: 'up-to-date' } })) { matchers.delete(m); m.resolve(true); }
		},
		fail: () => link.report(),
	};
	registerShapeLink(fake, link);
	return fake;
};
const goLive = async () => { shape.goLive(); await whenLive(shape); };

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failGet: null as null | ((k: string) => Error | null),
		failSet: null as null | ((k: string) => boolean),
		async get(k: string) {
			const error = this.failGet?.(k);
			if (error) throw error;
			return map.get(k) ?? null;
		},
		async set(k: string, v: string) {
			if (this.failSet?.(k)) throw new Error('storage down');
			map.set(k, v);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const cardRow = (ts: number, extra: Record<string, unknown> = {}) => resignedCard(ME, { owner_timestamp: ts, ...extra });
const { user_hash, name, sign_pkey, contact_pkey, contact_cert, crypt_pkey, crypt_cert } = ME.card as Record<string, string>;
const cardFields = { user_hash, name, sign_pkey, contact_pkey, contact_cert, crypt_pkey, crypt_cert };
const cardMutation = (type: 'insert' | 'update', ts: number) => ({
	type, ...(type === 'insert' ? { modified: cardRow(ts) } : { original: {}, changes: cardRow(ts) }), syncMetadata: { relation: 'user_cards' },
});
const bootstrapIntent = (ts: number, extra: Record<string, unknown> = {}) => enqueueIntent({
	kind: 'ready-row', relation: 'user_cards', mutationType: 'insert', purpose: BOOTSTRAP_CARD_PURPOSE, row: cardRow(ts), ...extra,
}, USER, 'user_cards');

let intents: ReturnType<typeof makeStorage>;
let outbox: ReturnType<typeof makeStorage>;
let accepted: ReturnType<typeof makeStorage>;
const acceptedKey = `user_cards:${USER}`;
const storeAccepted = (value: unknown) => accepted.map.set(acceptedKey, JSON.stringify(value));
const clockKey = `clock|user_cards|${USER}`;
const intentRecords = () => [...intents.map.keys()].filter((k) => !k.startsWith('owner|'));

const stillDeciding = async (decision: Promise<unknown>) => {
	let answered = false;
	void decision.finally(() => { answered = true; });
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return !answered;
};

beforeEach(() => {
	shape = makeShape();
	intents = makeStorage();
	outbox = makeStorage();
	accepted = makeStorage();
	_setIntentStorageForTests(intents);
	_setStorageForTests(outbox);
	_setAcceptedSnapshotStorageForTests(accepted);
});

describe('proven: the server has the card, nothing is authored', () => {
	it('an accepted card of this account', async () => {
		storeAccepted(cardRow(100));
		for (const mode of ['register', 'import', 'sign-in'] as const) {
			expect(await decideCardConstruction(USER, mode)).toEqual({ kind: 'proven' });
		}
	});

	it('the card in the current live shape', async () => {
		shape.rows.set(USER, cardRow(100));
		await goLive();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'proven' });
		expect(await decideCardConstruction(USER, 'import')).toEqual({ kind: 'proven' });
	});

	it('a bootstrap card the server accepted', async () => {
		await goLive();
		const outboxId = (await enqueue([cardMutation('insert', 100)], USER))!;
		await markServerAccepted(outboxId);
		await resolveIntent((await bootstrapIntent(100))!, { outcome: 'durably-dispatched', ref: outboxId });
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'proven' });
	});

	it('a tombstone is a card: proven for a bootstrap, an update (undelete) for an edit — never a new card', async () => {
		shape.rows.set(USER, cardRow(300, { deleted_flag: true }));
		await goLive();
		expect(await decideCardConstruction(USER, 'import')).toEqual({ kind: 'proven' });

		shape = makeShape();
		storeAccepted(cardRow(400, { deleted_flag: true }));
		const update = await decideCardConstruction(USER, 'update');
		expect(update).toMatchObject({ kind: 'author-update' });
		expect((update as { ownerTimestamp: number }).ownerTimestamp).toBeGreaterThan(400);
	});
});

describe('a card in the shape that does not verify proves nothing', () => {
	it('an edited (not re-signed) card: blocked card_unverified — never proven, never a new bootstrap or an update over it', async () => {
		shape.rows.set(USER, { ...cardRow(100), name: 'Forged' });
		await goLive();
		for (const mode of ['sign-in', 'import', 'update'] as const) {
			expect(await decideCardConstruction(USER, mode)).toEqual({ kind: 'blocked', reason: 'card_unverified' });
		}
		expect(intentRecords()).toHaveLength(0);
		expect(outbox.map.has(clockKey)).toBe(false);
	});
});

describe('reuse-bootstrap: the stored bootstrap operation, never a second one', () => {
	it('an unresolved bootstrap intent (unsigned or signed) is reused as that intent', async () => {
		await goLive();
		const id = await bootstrapIntent(100);
		expect(await decideCardConstruction(USER, 'import')).toMatchObject({ kind: 'reuse-bootstrap', operation: { kind: 'intent', intentId: id } });

		const signedId = await bootstrapIntent(100, { signedMutation: cardMutation('insert', 100) });
		intents.map.delete(id!);
		intents.map.delete(`owner|${id}`);
		expect(await decideCardConstruction(USER, 'register')).toMatchObject({ kind: 'reuse-bootstrap', operation: { kind: 'intent', intentId: signedId } });
	});

	it('a bootstrap already in the outbox is reused as that outbox entry', async () => {
		const outboxId = (await enqueue([cardMutation('insert', 100)], USER))!;
		const id = (await bootstrapIntent(100))!;
		await resolveIntent(id, { outcome: 'durably-dispatched', ref: outboxId });
		shape.fail();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'reuse-bootstrap', operation: { kind: 'stored', intentId: id, outboxId } });
	});

	it('an ordinary card update is never taken for a bootstrap', async () => {
		await goLive();
		await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', mutationType: 'update', row: cardRow(200) }, USER, 'user_cards');
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'card_unproven' });
	});

	it('a bootstrap the server refused → rejected, not a new card', async () => {
		await goLive();
		const outboxId = (await enqueue([cardMutation('insert', 100)], USER))!;
		await recordFailure(outboxId, new IngestError('validation_failed', { permanent: true }));
		await resolveIntent((await bootstrapIntent(100))!, { outcome: 'durably-dispatched', ref: outboxId });
		expect(await decideCardConstruction(USER, 'import')).toMatchObject({ kind: 'rejected' });
	});

	it('two registrations of one identity at once, under the card lock: one bootstrap intent, the second reuses it', async () => {
		const authorOrReuse = () => withCardLock(USER, async () => {
			const decision = await decideCardConstruction(USER, 'register');
			if (decision.kind !== 'author-bootstrap') return decision;
			return { kind: 'authored', ...(await storeCardIntentUnderLock(cardFields, decision)) };
		});
		const [first, second] = await Promise.all([authorOrReuse(), authorOrReuse()]);

		expect(first).toMatchObject({ kind: 'authored' });
		expect(second).toMatchObject({ kind: 'reuse-bootstrap', operation: { intentId: (first as { intentId: string }).intentId } });
		expect(intentRecords()).toHaveLength(1);
	});
});

describe('author-bootstrap: registration versus import', () => {
	it('registration: a freshly generated identity authors its bootstrap without waiting for the shape', async () => {
		const decision = await decideCardConstruction(USER, 'register');
		expect(decision).toMatchObject({ kind: 'author-bootstrap' });

		const { readyRow } = await storeCardIntentUnderLock(cardFields, decision as never);
		expect(readyRow).toMatchObject({ mutationType: 'insert', purpose: BOOTSTRAP_CARD_PURPOSE });
		expect(intentRecords()).toHaveLength(1);
	});

	it('import with no accepted card and a shape that is not live: waits, and a stream failure blocks — no insert', async () => {
		const decision = decideCardConstruction(USER, 'import');
		expect(await stillDeciding(decision)).toBe(true);
		shape.fail();
		expect(await decision).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });
		expect(outbox.map.has(clockKey)).toBe(false);
	});

	it('import with no accepted card and the current live shape showing none: a genuine bootstrap insert', async () => {
		await goLive();
		expect(await decideCardConstruction(USER, 'import')).toMatchObject({ kind: 'author-bootstrap' });
	});
});

describe('author-update: strictly newer than everything proven', () => {
	it('above the accepted card, the live shape, pending card writes and the card clock', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_000 * 1000);
		try {
			storeAccepted(cardRow(2_000));
			shape.rows.set(USER, cardRow(3_000));
			await goLive();
			await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', mutationType: 'update', row: cardRow(4_000) }, USER, 'user_cards');
			await enqueue([cardMutation('update', 5_000)], USER);
			outbox.map.set(clockKey, JSON.stringify({ highWater: 6_000 }));
			expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'author-update', ownerTimestamp: 6_001 });

			outbox.map.set(clockKey, JSON.stringify({ highWater: 1 }));
			expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'author-update', ownerTimestamp: 5_001 });
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('another account\'s card writes are not this card\'s base', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_000 * 1000);
		try {
			storeAccepted(cardRow(2_000));
			await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', row: { ...cardRow(9_000), user_hash: OTHER } }, OTHER, 'user_cards');
			expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'author-update', ownerTimestamp: 2_001 });
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('no card proven anywhere → blocked, not an update of a card that may not exist', async () => {
		await goLive();
		expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'blocked', reason: 'card_unproven' });
		shape.fail();
		expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });
	});

	it('a card clock that cannot be read blocks; one that cannot be written stores nothing', async () => {
		storeAccepted(cardRow(100));
		outbox.failGet = (k) => (k === clockKey ? new Error('io') : null);
		outbox.map.set(clockKey, JSON.stringify({ highWater: 1 }));
		expect(await decideCardConstruction(USER, 'update')).toEqual({ kind: 'blocked', reason: 'clock_unreadable' });

		outbox.failGet = null;
		const decision = await decideCardConstruction(USER, 'update');
		outbox.failSet = (k) => k === clockKey;
		await expect(storeCardIntentUnderLock(cardFields, decision as never)).rejects.toThrow('storage down');
		expect(intentRecords()).toHaveLength(0);
	});
});

describe('blocked: state that cannot be proven is never "no card"', () => {
	it('accepted card locked, unavailable, undecryptable, undecodable or another account\'s', async () => {
		await goLive();
		const cases: Array<[() => void, string]> = [
			[() => { accepted.failGet = () => new VaultLockedError('locked'); }, 'accepted_locked'],
			[() => { accepted.failGet = () => new Error('io'); }, 'accepted_unavailable'],
			[() => { accepted.failGet = () => new DecryptFailedError('bad tag'); }, 'accepted_corrupt'],
			[() => { accepted.failGet = null; accepted.map.set(acceptedKey, '{not json'); }, 'accepted_corrupt'],
			[() => { storeAccepted({ ...cardRow(100), user_hash: OTHER }); }, 'accepted_corrupt'],
		];
		for (const [arrange, reason] of cases) {
			arrange();
			for (const mode of ['register', 'import', 'sign-in', 'update'] as const) {
				expect(await decideCardConstruction(USER, mode)).toEqual({ kind: 'blocked', reason });
			}
		}
		expect(intentRecords()).toHaveLength(0);
		expect(outbox.map.has(clockKey)).toBe(false);
	});

	it('an own bootstrap intent that cannot be parsed', async () => {
		await goLive();
		const id = (await bootstrapIntent(100))!;
		intents.map.set(id, '{not json');
		expect(await decideCardConstruction(USER, 'import')).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
		expect(await decideCardConstruction(USER, 'register')).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('an own intent that cannot be read next to a refused bootstrap: blocked, not rejected — it may be a later bootstrap', async () => {
		await goLive();
		const outboxId = (await enqueue([cardMutation('insert', 100)], USER))!;
		await recordFailure(outboxId, new IngestError('validation_failed', { permanent: true }));
		await resolveIntent((await bootstrapIntent(100))!, { outcome: 'durably-dispatched', ref: outboxId });
		const later = (await bootstrapIntent(200))!;
		intents.map.set(later, '{not json');
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('an own bootstrap whose stored outbox write cannot be read', async () => {
		await goLive();
		const outboxId = (await enqueue([cardMutation('insert', 100)], USER))!;
		await resolveIntent((await bootstrapIntent(100))!, { outcome: 'durably-dispatched', ref: outboxId });
		outbox.failGet = (k) => (k === outboxId ? new Error('io') : null);
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'bootstrap_unconfirmed' });
	});

	it('sign-in: the live shape has no card and nothing else proves one; a shape that failed proves nothing either', async () => {
		await goLive();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'card_unproven' });
		shape.fail();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });
	});
});

describe('the shape proves only within its current live generation', () => {
	it('live → stream failure: neither the stale card nor the stale absence decides', async () => {
		shape.rows.set(USER, cardRow(100));
		await goLive();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'proven' });
		shape.fail();
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });

		shape.rows.clear();
		expect(await decideCardConstruction(USER, 'import')).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });
	});

	it('failure → a new up-to-date: the current state decides again', async () => {
		await goLive();
		shape.fail();
		expect(await decideCardConstruction(USER, 'import')).toEqual({ kind: 'blocked', reason: 'shape_unavailable' });
		await goLive();
		expect(await decideCardConstruction(USER, 'import')).toMatchObject({ kind: 'author-bootstrap' });
		shape.rows.set(USER, cardRow(100));
		expect(await decideCardConstruction(USER, 'sign-in')).toEqual({ kind: 'proven' });
	});
});
