import { describe, it, expect, beforeEach } from 'vitest';
import { loadOwed, updateOwed } from '@/lib/avatars/localStore';
import { useMemoryAvatarStore } from './helpers/avatarLocalStore';
import { createAvatarDelivery, changeMessage, NO_KEY_TTL_MS, PROBE_CONCURRENCY, type DeliveryDeps } from '@/lib/avatars/delivery';
import { galleryOf, type GalleryEntry, type GalleryMessage } from '@/lib/avatars/gallery';
import type { AvatarPhoto, ContentPart } from '@/lib/pq/content';

// pq_avatars § Delivery, driven through fakes that keep the contract: a sent
// message lands in the peer's dialog, and the next probe of it sees it.

const ME = 'u_' + 'a'.repeat(128);
const id = (c: string) => c.repeat(32);
const photo = (n: number): AvatarPhoto => ({
	kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: n,
	mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + String(n).repeat(32).slice(0, 32), encSecretB64: 'k',
});
const entry = (c: string, n = 1): GalleryEntry => ({ avatarId: id(c), photo: photo(n) });

beforeEach(() => { useMemoryAvatarStore(); });

const world = (opts: { gallery?: GalleryEntry[]; contacts?: string[]; sentTo?: string[]; unreadable?: string[] } = {}) => {
	const dialogs = new Map<string, GalleryMessage[]>();
	for (const peer of opts.sentTo ?? []) dialogs.set(peer, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	const sends: { peer: string; parts: ContentPart[] }[] = [];
	const state = {
		gallery: opts.gallery ?? [], probes: [] as string[], clock: 1000, inProbe: 0, maxInProbe: 0,
		// The slot as another device may have changed it; `gallery` is this device's last read of it.
		slot: null as GalleryEntry[] | null, freshReads: 0, unreadable: new Set(opts.unreadable ?? []),
	};
	let seq = 1;
	const contacts = opts.contacts ?? [];
	const deps: DeliveryDeps = {
		gallery: async ({ fresh = false } = {}) => {
			if (fresh) {
				state.freshReads++;
				if (state.slot) state.gallery = state.slot;
			}
			return state.gallery;
		},
		contacts: () => contacts,
		isTarget: (p) => contacts.includes(p),
		probe: async (p, { requireOwnKey }) => {
			state.probes.push(p);
			state.inProbe++;
			state.maxInProbe = Math.max(state.maxInProbe, state.inProbe);
			await new Promise((r) => setTimeout(r, 1));
			state.inProbe--;
			if (state.unreadable.has(p)) return { ownKey: requireOwnKey ? null : undefined, carries: null };
			const ownKey = dialogs.has(p);
			if (requireOwnKey && !ownKey) return { ownKey, carries: null };
			return { ownKey, carries: (dialogs.get(p) ?? []).some((m) => m.parts.some((x) => x.kind === 'avatar')) };
		},
		send: async (p, parts) => {
			sends.push({ peer: p, parts });
			const list = dialogs.get(p) ?? [];
			list.push({ messageId: `dmsg_${String(seq++).padStart(4, '0')}`, senderHash: ME, parts });
			dialogs.set(p, list);
		},
		now: () => state.clock,
		owed: { load: () => loadOwed(ME), update: (change) => updateOwed(ME, change) },
	};
	const readerGallery = (peer: string) => galleryOf(dialogs.get(peer) ?? [], ME).map((e) => e.avatarId[0]);
	return { deps, sends, state, dialogs, readerGallery, delivery: createAvatarDelivery(deps) };
};

const kinds = (parts: ContentPart[]) => parts.map((p) => `${p.kind}:${(p as { avatarId?: string }).avatarId?.[0] ?? ''}`);
const sendAvatar = (w: ReturnType<typeof world>, peer: string, c: string) => w.deps.send(peer, [{ kind: 'avatar', avatarId: id(c), photo: photo(1) }]);

describe('rule 1: a change goes to every dialog the account has', () => {
	it('sends the change alone where the dialog already carries the gallery', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'P2'] });
		await sendAvatar(w, 'P1', 'a');
		await sendAvatar(w, 'P2', 'a');
		w.sends.length = 0;
		const result = await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('b'), photo: photo(1) });
		expect(result).toEqual({ sent: ['P1', 'P2'], failed: [], pending: [] });
		expect(w.sends.map((s) => kinds(s.parts))).toEqual([['avatar:b'], ['avatar:b']]);
	});

	it('sends the whole gallery where the dialog has none of it yet, not a gallery of one', async () => {
		const w = world({ gallery: [entry('c'), entry('b'), entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('c'), photo: photo(1) });
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:a', 'avatar:b', 'avatar:c']);
		expect(w.readerGallery('P1')).toEqual(['c', 'b', 'a']);
	});

	it('skips contacts never written to, and does not read their dialogs again for the next change', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'STRANGER'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(w.sends.map((s) => s.peer)).toEqual(['P1']);
		w.state.probes.length = 0;
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(w.state.probes).toEqual(['P1']);
		w.state.clock += NO_KEY_TTL_MS + 1;
		w.state.probes.length = 0;
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(w.state.probes.sort()).toEqual(['P1', 'P2']);
	});

	it('a contact the account then writes to is probed again at once', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P2'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(await w.delivery.onOwnSend('P2', [{ kind: 'text', text: 'hi' }])).toBe('sent');
		w.state.probes.length = 0;
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(w.state.probes).toEqual(['P2']);
	});

	it('probes at most a few dialogs at once', async () => {
		const contacts = Array.from({ length: 12 }, (_, i) => `P${i}`);
		const w = world({ gallery: [entry('a')], contacts, sentTo: contacts });
		const result = await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(result.sent).toHaveLength(12);
		expect(w.state.maxInProbe).toBeGreaterThan(1);
		expect(w.state.maxInProbe).toBeLessThanOrEqual(PROBE_CONCURRENCY);
	});

	it('a removal reaches a dialog carrying the gallery as the removal alone', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await sendAvatar(w, 'P1', 'a');
		await sendAvatar(w, 'P1', 'b');
		w.sends.length = 0;
		await w.delivery.deliverChange({ kind: 'avatar_removed', avatarId: id('b') });
		expect(kinds(w.sends[0].parts)).toEqual(['avatar_removed:b']);
		expect(w.readerGallery('P1')).toEqual(['a']);
	});

	it('an unreadable dialog gets the gallery with the removal after it; one known to carry nothing, the gallery alone', () => {
		const removal = { kind: 'avatar_removed' as const, avatarId: id('b') };
		expect(kinds(changeMessage(removal, [entry('a')], null))).toEqual(['avatar:a', 'avatar_removed:b']);
		expect(kinds(changeMessage(removal, [entry('a')], false))).toEqual(['avatar:a']);
		expect(changeMessage(removal, [], false)).toEqual([]);
	});

	it('one dialog refusing does not stop the others, and is reported', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'P2'] });
		const send = w.deps.send;
		w.deps.send = async (p, parts) => { if (p === 'P1') throw new Error('not stored'); return send(p, parts); };
		const result = await createAvatarDelivery(w.deps).deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(result.sent).toEqual(['P2']);
		expect(result.failed.map((f) => f.peerHash)).toEqual(['P1']);
	});
});

describe('rule 2: the first message in a dialog brings the gallery', () => {
	const text: ContentPart[] = [{ kind: 'text', text: 'hello' }];

	it('sends the gallery, oldest first, once', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('sent');
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:a', 'avatar:b']);
		expect(await w.delivery.onOwnSend('P1', text)).toBe('present');
		expect(w.sends).toHaveLength(1);
		expect(w.readerGallery('P1')).toEqual(['b', 'a']);
	});

	it('two messages sent at once still bring one snapshot: the second probe sees the first send', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'] });
		const outcomes = await Promise.all([w.delivery.onOwnSend('P1', text), w.delivery.onOwnSend('P1', text)]);
		expect(outcomes.sort()).toEqual(['present', 'sent']);
		expect(w.sends).toHaveLength(1);
	});

	it('with no photo, sends nothing and does not read the dialog at all', async () => {
		const w = world({ gallery: [], contacts: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('empty');
		expect(w.state.probes).toEqual([]);
		expect(w.sends).toHaveLength(0);
	});

	it('does nothing where the dialog already carries an avatar part from this account', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await sendAvatar(w, 'P1', 'a');
		w.sends.length = 0;
		expect(await w.delivery.onOwnSend('P1', text)).toBe('present');
		expect(w.sends).toHaveLength(0);
	});

	it('its own avatar messages never trigger it: no loop', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', [{ kind: 'avatar', avatarId: id('a'), photo: photo(1) }])).toBe('skipped');
		expect(await w.delivery.onOwnSend('P1', [{ kind: 'avatar_removed', avatarId: id('a') }])).toBe('skipped');
		expect(w.sends).toHaveLength(0);
	});

	it('sends nothing to someone who is not a contact', async () => {
		const w = world({ gallery: [entry('a')], contacts: [] });
		expect(await w.delivery.onOwnSend('STRANGER', text)).toBe('skipped');
		expect(w.state.probes).toEqual([]);
	});

	it('a dialog it could not read is tried again at the next message, not guessed', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], unreadable: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('unknown');
		expect(w.sends).toHaveLength(0);
	});

	// Whichever runs first sends the gallery; the other then finds the dialog
	// carrying it and adds at most the change itself.
	it('a change and a first message racing in one dialog send one gallery between them', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await Promise.all([
			w.delivery.deliverChange({ kind: 'avatar', avatarId: id('b'), photo: photo(1) }),
			w.delivery.onOwnSend('P1', text),
		]);
		expect(w.sends.filter((s) => s.parts.length > 1)).toHaveLength(1);
		expect(w.readerGallery('P1')).toEqual(['b', 'a']);
	});
});

describe('the gallery a snapshot carries is the slot\'s as it is now', () => {
	it('a photo removed on another device never goes to a new contact', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1'] });
		// another device took 'a' out; this device's last read still has it
		w.state.slot = [entry('b')];
		expect(await w.delivery.onOwnSend('P1', [{ kind: 'text', text: 'hello' }])).toBe('sent');
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:b']);
	});
});

describe('nothing owed is dropped', () => {
	const text: ContentPart[] = [{ kind: 'text', text: 'hello' }];

	it('a change records every dialog as owed before sending into any', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'P2'] });
		const seenOwed: string[][] = [];
		const probe = w.deps.probe;
		w.deps.probe = async (p, o) => {
			seenOwed.push(Object.keys(await loadOwed(ME)).sort());
			return probe(p, o);
		};
		await createAvatarDelivery(w.deps).deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(seenOwed[0]).toEqual(['P1', 'P2']);
		expect(await loadOwed(ME)).toEqual({});
	});

	it('a dialog that could not be read stays owed, is reported pending, and is caught up once it can be read', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], sentTo: ['P1'], unreadable: ['P1'] });
		await sendAvatar(w, 'P1', 'z');
		w.sends.length = 0;
		const result = await w.delivery.deliverChange({ kind: 'avatar_removed', avatarId: id('z') });
		expect(result).toEqual({ sent: [], failed: [], pending: ['P1'] });
		expect(w.sends).toEqual([]);
		expect(await loadOwed(ME)).toEqual({ P1: { change: true, removed: [id('z')] } });

		w.state.unreadable.clear();
		const retried = await w.delivery.retryOwed();
		expect(retried.sent).toEqual(['P1']);
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:a', 'avatar_removed:z']);
		expect(w.readerGallery('P1')).toEqual(['a']);
		expect(await loadOwed(ME)).toEqual({});
	});

	it('a send that was not stored stays owed, and goes out at the next message into that dialog', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		const send = w.deps.send;
		w.deps.send = async () => { throw new Error('not stored'); };
		const delivery = createAvatarDelivery(w.deps);
		const result = await delivery.deliverChange({ kind: 'avatar', avatarId: id('b'), photo: photo(1) });
		expect(result.failed.map((f) => f.peerHash)).toEqual(['P1']);
		expect(Object.keys(await loadOwed(ME))).toEqual(['P1']);

		w.deps.send = send;
		expect(await delivery.onOwnSend('P1', text)).toBe('caught-up');
		expect(w.readerGallery('P1')).toEqual(['b', 'a']);
		expect(await loadOwed(ME)).toEqual({});
	});

	it('a first message whose dialog could not be read is owed the gallery, sent once it can be', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], unreadable: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('unknown');
		expect(await loadOwed(ME)).toEqual({ P1: { first: true, removed: [] } });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('owed');
		w.state.unreadable.clear();
		expect((await w.delivery.retryOwed()).sent).toEqual(['P1']);
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:a']);
		expect(await loadOwed(ME)).toEqual({});
	});

	it('what is owed to someone not (yet) a contact is kept, not sent and not dropped', async () => {
		const w = world({ gallery: [entry('a')], contacts: [] });
		await updateOwed(ME, (o) => { o.P9 = { first: true }; });
		const result = await w.delivery.retryOwed();
		expect(result).toEqual({ sent: [], failed: [], pending: [] });
		expect(Object.keys(await loadOwed(ME))).toEqual(['P9']);
	});

	it('a dialog the account has not sent in is owed nothing', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P2'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(await loadOwed(ME)).toEqual({});
	});
});
