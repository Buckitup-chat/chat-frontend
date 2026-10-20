import { serialized } from '@/lib/data/serialized';
import {
	AVATAR_GALLERY_ACCESS_VERSION, type AvatarGalleryAccessPart, type ContentPart,
} from '@/lib/pq/content';
import type { GalleryMapping } from './galleryMapping';
import type { GrantedMap } from './localStore';
import type { GalleryGrant } from './peerGallery';

export const isGrantPart = (part: ContentPart): part is AvatarGalleryAccessPart => part.kind === 'avatar_gallery_access';

export const grantPartOf = (mapping: GalleryMapping): AvatarGalleryAccessPart => ({
	kind: 'avatar_gallery_access',
	version: AVATAR_GALLERY_ACCESS_VERSION,
	galleryUuid: mapping.galleryUuid,
	galleryKeyB64: mapping.galleryKeyB64,
});

export interface DialogMessageView {
	id?: string;
	_verify?: string;
	_deleted?: boolean;
	_raw?: { sender_hash?: string; message_id?: string };
	parts?: ContentPart[];
}

export type ReadGrant = GalleryGrant & { messageId: string };

export const grantFromMessages = (messages: DialogMessageView[] | null | undefined, peerHash: string): ReadGrant | null => {
	let newest: ReadGrant | null = null;
	for (const m of messages ?? []) {
		if (m._verify !== 'verified' || m._deleted || m._raw?.sender_hash !== peerHash) continue;
		const messageId = m._raw?.message_id ?? m.id;
		const part = [...(m.parts ?? [])].reverse().find(isGrantPart);
		if (!part || !messageId) continue;
		if (!newest || messageId > newest.messageId) {
			newest = { ownerHash: peerHash, galleryUuid: part.galleryUuid, galleryKeyB64: part.galleryKeyB64, messageId };
		}
	}
	return newest;
};

export interface GrantDeliveryDeps {
	grant(): Promise<AvatarGalleryAccessPart | null>;
	peers(): Promise<string[]>;
	isTarget(peerHash: string): boolean;
	granted: {
		load(): Promise<GrantedMap>;
		mark(peerHash: string, galleryUuid: string): Promise<void>;
	};
	carries(peerHash: string, grant: AvatarGalleryAccessPart): Promise<'confirmed' | 'pending' | 'none' | null>;
	send(peerHash: string, parts: ContentPart[]): Promise<void>;
}

export type GrantOutcome = 'sent' | 'had' | 'pending' | 'unknown' | 'failed';

export const createGrantDelivery = (deps: GrantDeliveryDeps) => {
	const locks = new Map<string, Promise<unknown>>();
	const known = new Set<string>();

	const deliverTo = (peerHash: string, grant: AvatarGalleryAccessPart): Promise<GrantOutcome> =>
		serialized(locks, peerHash, async (): Promise<GrantOutcome> => {
			const memo = `${peerHash}|${grant.galleryUuid}`;
			if (known.has(memo)) return 'had';
			if ((await deps.granted.load())[peerHash] === grant.galleryUuid) {
				known.add(memo);
				return 'had';
			}
			const carries = await deps.carries(peerHash, grant);
			if (carries === null) return 'unknown';
			if (carries === 'confirmed') {
				await deps.granted.mark(peerHash, grant.galleryUuid);
				known.add(memo);
				return 'had';
			}
			if (carries === 'pending') return 'pending';
			try {
				await deps.send(peerHash, [grant]);
			} catch (e) {
				console.warn('[galleryGrants] the grant was not stored for', peerHash, (e as Error)?.message ?? e);
				return 'failed';
			}
			return 'sent';
		});

	const grantAll = async (): Promise<Record<string, GrantOutcome> | null> => {
		const grant = await deps.grant();
		if (!grant) return null;
		const outcomes: Record<string, GrantOutcome> = {};
		for (const peer of (await deps.peers()).filter(deps.isTarget)) {
			try {
				outcomes[peer] = await deliverTo(peer, grant);
			} catch (e) {
				console.warn('[galleryGrants] dialog not granted:', peer, (e as Error)?.message ?? e);
				outcomes[peer] = 'unknown';
			}
		}
		return outcomes;
	};

	const onOwnSend = async (peerHash: string, parts: ContentPart[]): Promise<GrantOutcome | 'skipped' | 'not-ready'> => {
		if (parts.some(isGrantPart) || !deps.isTarget(peerHash)) return 'skipped';
		const grant = await deps.grant();
		if (!grant) return 'not-ready';
		return deliverTo(peerHash, grant);
	};

	return { grantAll, onOwnSend };
};
