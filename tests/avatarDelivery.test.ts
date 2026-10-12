import { describe, it, expect } from 'vitest';
import { createAvatarDelivery, changeMessage, type DeliveryDeps } from '@/lib/avatars/delivery';
import { galleryOf, type GalleryEntry, type GalleryMessage } from '@/lib/avatars/gallery';
import type { AvatarPhoto, ContentPart } from '@/lib/pq/content';

// pq_avatars § Delivery, driven through fakes that keep the contract: a sent
// message lands in the peer's dialog, and reading the dialog sees it.

const ME = 'u_' + 'a'.repeat(128);
const id = (c: string) => c.repeat(32);
const photo = (n: number): AvatarPhoto => ({
	kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: n,
	mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + String(n).repeat(32).slice(0, 32), encSecretB64: 'k',
});
const entry = (c: string, n = 1): GalleryEntry => ({ avatarId: id(c), photo: photo(n) });

const world = (opts: { gallery?: GalleryEntry[]; contacts?: string[]; sentTo?: string[]; unreadable?: string[] } = {}) => {
	const dialogs = new Map<string, GalleryMessage[]>();
	for (const peer of opts.sentTo ?? []) dialogs.set(peer, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	const markers = new Set<string>();
	const sends: { peer: string; parts: ContentPart[] }[] = [];
	const state = { gallery: opts.gallery ?? [], reads: 0 };
	let seq = 1;
	const contacts = opts.contacts ?? [];
	const deps: DeliveryDeps = {
		gallery: async () => state.gallery,
		targets: async () => contacts.filter((p) => dialogs.has(p)),
		isTarget: (p) => contacts.includes(p),
		readCarries: async (p) => {
			state.reads++;
			if (opts.unreadable?.includes(p)) return null;
			return (dialogs.get(p) ?? []).some((m) => m.senderHash === ME && m.parts.some((x) => x.kind === 'avatar'));
		},
		marked: (p) => markers.has(p),
		mark: (p) => { markers.add(p); },
		send: async (p, parts) => {
			sends.push({ peer: p, parts });
			const list = dialogs.get(p) ?? [];
			list.push({ messageId: `dmsg_${String(seq++).padStart(4, '0')}`, senderHash: ME, parts });
			dialogs.set(p, list);
		},
	};
	const readerGallery = (peer: string) => galleryOf(dialogs.get(peer) ?? [], ME).map((e) => e.avatarId[0]);
	return { deps, sends, markers, state, readerGallery, delivery: createAvatarDelivery(deps) };
};

const kinds = (parts: ContentPart[]) => parts.map((p) => `${p.kind}:${(p as { avatarId?: string }).avatarId?.[0] ?? ''}`);

describe('rule 1: a change goes to every dialog the account has', () => {
	it('sends the change alone where the dialog already carries the gallery', async () => {
		const w = world({ gallery: [entry('b'), entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'P2'] });
		w.markers.add('P1');
		w.markers.add('P2');
		const result = await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('b'), photo: photo(1) });
		expect(result).toEqual({ sent: ['P1', 'P2'], failed: [] });
		expect(w.sends.map((s) => kinds(s.parts))).toEqual([['avatar:b'], ['avatar:b']]);
	});

	it('sends the whole gallery where the dialog has none of it yet, not a gallery of one', async () => {
		const w = world({ gallery: [entry('c'), entry('b'), entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('c'), photo: photo(1) });
		expect(kinds(w.sends[0].parts)).toEqual(['avatar:a', 'avatar:b', 'avatar:c']);
		expect(w.readerGallery('P1')).toEqual(['c', 'b', 'a']);
		expect(w.markers.has('P1')).toBe(true);
	});

	it('skips contacts never written to and people who are not contacts', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1', 'P2'], sentTo: ['P1', 'STRANGER'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('a'), photo: photo(1) });
		expect(w.sends.map((s) => s.peer)).toEqual(['P1']);
	});

	it('a removal reaches a dialog read as carrying the gallery as the removal', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await w.delivery.deliverChange({ kind: 'avatar', avatarId: id('b'), photo: photo(2) });
		w.state.gallery = [entry('a')];
		w.sends.length = 0;
		await w.delivery.deliverChange({ kind: 'avatar_removed', avatarId: id('b') });
		expect(kinds(w.sends[0].parts)).toEqual(['avatar_removed:b']);
		expect(w.readerGallery('P1')).toEqual(['a']);
	});

	it('an unreadable dialog gets the gallery with the removal after it, which leaves it right either way', () => {
		expect(kinds(changeMessage({ kind: 'avatar_removed', avatarId: id('b') }, [entry('a')], null)))
			.toEqual(['avatar:a', 'avatar_removed:b']);
		expect(changeMessage({ kind: 'avatar_removed', avatarId: id('b') }, [], false)).toEqual([{ kind: 'avatar_removed', avatarId: id('b') }]);
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

	it('two messages sent at once still bring one snapshot', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'] });
		const outcomes = await Promise.all([w.delivery.onOwnSend('P1', text), w.delivery.onOwnSend('P1', text)]);
		expect(outcomes.sort()).toEqual(['present', 'sent']);
		expect(w.sends).toHaveLength(1);
	});

	it('does nothing where the dialog already carries an avatar part from this account, and remembers it', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], sentTo: ['P1'] });
		await w.deps.send('P1', [{ kind: 'avatar', avatarId: id('a'), photo: photo(1) }]);
		w.sends.length = 0;
		expect(await w.delivery.onOwnSend('P1', text)).toBe('present');
		expect(w.sends).toHaveLength(0);
		const reads = w.state.reads;
		expect(await w.delivery.onOwnSend('P1', text)).toBe('present');
		expect(w.state.reads).toBe(reads);
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
		expect(w.sends).toHaveLength(0);
	});

	it('an empty gallery sends nothing and leaves the dialog for later', async () => {
		const w = world({ gallery: [], contacts: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('empty');
		expect(w.markers.has('P1')).toBe(false);
	});

	it('a dialog it could not read is tried again at the next message, not guessed', async () => {
		const w = world({ gallery: [entry('a')], contacts: ['P1'], unreadable: ['P1'] });
		expect(await w.delivery.onOwnSend('P1', text)).toBe('unknown');
		expect(w.sends).toHaveLength(0);
		expect(w.markers.has('P1')).toBe(false);
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
