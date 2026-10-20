import { describe, it, expect, beforeEach } from 'vitest';
import {
	grantPartOf, grantFromMessages, createGrantDelivery, type GrantDeliveryDeps,
} from '@/lib/avatars/galleryGrants';
import type { AvatarGalleryAccessPart, ContentPart } from '@/lib/pq/content';
import type { GalleryMapping } from '@/lib/avatars/galleryMapping';
import type { GrantedMap } from '@/lib/avatars/localStore';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const OTHER = 'u_' + 'c'.repeat(128);
const MAPPING: GalleryMapping = { galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: 'K'.repeat(42) + 'w', generation: 1 };
const GRANT = grantPartOf(MAPPING);
const mid = (n: number) => `dmsg_0190a3b2-${String(n).padStart(4, '0')}-7e5f-8a6b-7c8d9e0f1a2b`;

describe('the grant part', () => {
	it('names the mapping\'s gallery and key, at the version this build writes', () => {
		expect(GRANT).toEqual({ kind: 'avatar_gallery_access', version: 1, galleryUuid: MAPPING.galleryUuid, galleryKeyB64: MAPPING.galleryKeyB64 });
	});
});

describe('grantFromMessages', () => {
	const message = (n: number, parts: ContentPart[], over: Record<string, unknown> = {}) => ({
		id: mid(n), _verify: 'verified', _raw: { sender_hash: PEER, message_id: mid(n) }, parts, ...over,
	});
	const other = { ...GRANT, galleryUuid: '1c8f4b63-ad2e-4071-9b3c-4d5e6f7a8b9c' };

	it('is the newest grant in the peer\'s own verified, live messages, its owner the sender', () => {
		const found = grantFromMessages([message(2, [other]), message(1, [GRANT]), message(3, [{ kind: 'text', text: 'hi' }])], PEER);
		expect(found).toEqual({ ownerHash: PEER, galleryUuid: other.galleryUuid, galleryKeyB64: other.galleryKeyB64, messageId: mid(2) });
	});
});

describe('handing the grant out', () => {
	let world: ReturnType<typeof makeWorld>;

	const makeWorld = () => {
		type Stored = { parts: ContentPart[]; state: 'pending' | 'confirmed' };
		const dialogs = new Map<string, Stored[]>();
		let granted: GrantedMap = {};
		const w = {
			dialogs,
			ready: true as boolean,
			unreadable: new Set<string>(),
			refusing: new Set<string>(),
			sends: [] as Array<{ peer: string; parts: ContentPart[] }>,
			reads: 0,
			marks: () => granted,
			take: (peer: string) => { for (const m of dialogs.get(peer) ?? []) m.state = 'confirmed'; },
			refuse: (peer: string) => { dialogs.set(peer, (dialogs.get(peer) ?? []).filter((m) => m.state === 'confirmed')); },
			deps: null as unknown as GrantDeliveryDeps,
		};
		const grantIn = (m: Stored, grant: AvatarGalleryAccessPart) => m.parts.some((p) => p.kind === 'avatar_gallery_access' && p.galleryUuid === grant.galleryUuid);
		w.deps = {
			grant: async () => (w.ready ? GRANT : null),
			peers: async () => [...dialogs.keys()],
			isTarget: (peer) => peer !== ME,
			granted: {
				load: async () => ({ ...granted }),
				mark: async (peer, uuid) => { granted = { ...granted, [peer]: uuid }; },
			},
			carries: async (peer, grant) => {
				w.reads++;
				if (w.unreadable.has(peer)) return null;
				const own = dialogs.get(peer) ?? [];
				if (own.some((m) => m.state === 'confirmed' && grantIn(m, grant))) return 'confirmed';
				return own.some((m) => grantIn(m, grant)) ? 'pending' : 'none';
			},
			send: async (peer, parts) => {
				if (w.refusing.has(peer)) throw new Error('could not be stored');
				w.sends.push({ peer, parts });
				dialogs.set(peer, [...(dialogs.get(peer) ?? []), { parts, state: 'pending' }]);
			},
		};
		return w;
	};
	const text = (t: string): { parts: ContentPart[]; state: 'confirmed' } => ({ parts: [{ kind: 'text', text: t }], state: 'confirmed' });

	beforeEach(() => {
		world = makeWorld();
		world.dialogs.set(PEER, [text('hi')]);
		world.dialogs.set(OTHER, [text('hi')]);
	});

	it('gives every dialog this account wrote in one grant, recorded only once the server took it', async () => {
		const delivery = createGrantDelivery(world.deps);
		expect(await delivery.grantAll()).toEqual({ [PEER]: 'sent', [OTHER]: 'sent' });
		expect(world.sends).toEqual([{ peer: PEER, parts: [GRANT] }, { peer: OTHER, parts: [GRANT] }]);
		expect(world.marks()).toEqual({});
		world.take(PEER);
		world.take(OTHER);
		expect(await delivery.grantAll()).toEqual({ [PEER]: 'had', [OTHER]: 'had' });
		expect(world.marks()).toEqual({ [PEER]: MAPPING.galleryUuid, [OTHER]: MAPPING.galleryUuid });
		expect(world.sends).toHaveLength(2);
	});

	it('a grant still on its way is not sent again, and not recorded', async () => {
		const delivery = createGrantDelivery(world.deps);
		await delivery.grantAll();
		expect(await delivery.grantAll()).toEqual({ [PEER]: 'pending', [OTHER]: 'pending' });
		expect(world.sends).toHaveLength(2);
		expect(world.marks()).toEqual({});
	});

	it('a grant the server refused after it was stored is sent again by a later pass', async () => {
		const delivery = createGrantDelivery(world.deps);
		await delivery.grantAll();
		world.refuse(PEER);
		world.take(OTHER);
		expect(await delivery.grantAll()).toEqual({ [PEER]: 'sent', [OTHER]: 'had' });
		expect(world.sends.map((s) => s.peer)).toEqual([PEER, OTHER, PEER]);
		expect(world.marks()).toEqual({ [OTHER]: MAPPING.galleryUuid });
	});

	describe('the first message into a dialog', () => {
		it('brings the grant after it, once', async () => {
			const delivery = createGrantDelivery(world.deps);
			const fresh = 'u_' + 'f'.repeat(128);
			world.dialogs.set(fresh, [text('hello')]);
			expect(await delivery.onOwnSend(fresh, [{ kind: 'text', text: 'hello' }])).toBe('sent');
			expect(await delivery.onOwnSend(fresh, [{ kind: 'text', text: 'again' }])).toBe('pending');
			world.take(fresh);
			expect(await delivery.onOwnSend(fresh, [{ kind: 'text', text: 'and again' }])).toBe('had');
			expect(world.sends).toEqual([{ peer: fresh, parts: [GRANT] }]);
		});
	});
});
