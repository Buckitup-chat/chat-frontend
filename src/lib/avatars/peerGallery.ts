import { isGalleryUuid } from '@/lib/pq/content';
import { isShapeBlocked } from '@/lib/data/accessGate';
import { getVerifiedSignPkey } from '@/lib/data/cardRegistry';
import { currentSessionToken, sameSessionToken, type SessionToken } from '@/lib/data/outbox';
import type { SignPkeyResolver } from '@/lib/data/rowVerification';
import { pinActiveSession, SessionFencedError } from '@/lib/data/sessionGuard';
import { readShapeOnce } from '@/lib/data/shapeRead';
import type { UserStorageRow } from '@/lib/data/types';
import { shapeOfTable } from '@/lib/data/writeContracts';
import {
	galleryKeyFromB64, readSharedGalleryRow,
	type GalleryAddress, type GalleryRowRead, type SharedGalleryState,
} from './sharedGallery';

const USER_HASH = /^u_[0-9a-f]{128}$/;

export interface GalleryGrant extends GalleryAddress {
	galleryKeyB64: string;
}

export type PeerGalleryState =
	| SharedGalleryState
	| { state: 'superseded' };

export type DisplayablePeerGallery = Extract<SharedGalleryState, { state: 'gallery' | 'empty' | 'deleted' }>;

export const isDisplayable = (state: PeerGalleryState): state is DisplayablePeerGallery =>
	state.state === 'gallery' || state.state === 'empty' || state.state === 'deleted';

let resolveSignPkey: SignPkeyResolver = getVerifiedSignPkey;

export const _setPeerGallerySignPkeyResolverForTests = (resolver: SignPkeyResolver | null): void => {
	resolveSignPkey = resolver ?? getVerifiedSignPkey;
};

const assertGalleryAddress = ({ ownerHash, galleryUuid }: GalleryAddress): void => {
	if (!USER_HASH.test(ownerHash)) throw new TypeError('not a user hash');
	if (!isGalleryUuid(galleryUuid)) throw new TypeError('not a gallery uuid');
};

export const fetchGalleryRow = async ({ ownerHash, galleryUuid }: GalleryAddress): Promise<GalleryRowRead> => {
	assertGalleryAddress({ ownerHash, galleryUuid });
	try {
		const rows = await readShapeOnce<UserStorageRow>('user_storage', `user_hash='${ownerHash}' AND uuid='${galleryUuid}'`);
		return { kind: 'rows', rows };
	} catch {
		return isShapeBlocked(shapeOfTable('user_storage')) ? { kind: 'blocked' } : { kind: 'failed' };
	}
};

interface Entry {
	session: SessionToken;
	grant: GalleryGrant;
	inflight: Promise<PeerGalleryState> | null;
}

const entries = new Map<string, Entry>();

const sameGrant = (a: GalleryGrant, b: GalleryGrant) =>
	a.ownerHash === b.ownerHash && a.galleryUuid === b.galleryUuid && a.galleryKeyB64 === b.galleryKeyB64;

const readOnce = async (id: string, current: Entry, key: Uint8Array): Promise<PeerGalleryState> => {
	const { grant, session } = current;
	const state = await readSharedGalleryRow(await fetchGalleryRow(grant), grant, key, resolveSignPkey);
	if (!sameSessionToken(session, currentSessionToken())) {
		throw new SessionFencedError('peer gallery read: fenced — the session changed while reading');
	}
	return entries.get(id) === current ? state : { state: 'superseded' };
};

export const readPeerGallery = (readerHash: string, grant: GalleryGrant, { fresh = false } = {}): Promise<PeerGalleryState> => {
	const session = pinActiveSession(readerHash, 'peer gallery read');
	const key = galleryKeyFromB64(grant.galleryKeyB64);
	const id = `${readerHash}|${grant.ownerHash}`;
	let entry = entries.get(id);
	if (!entry || !sameSessionToken(entry.session, session) || !sameGrant(entry.grant, grant)) {
		entry = { session, grant: { ...grant }, inflight: null };
		entries.set(id, entry);
	}
	if (entry.inflight && fresh) {
		const waited = entry;
		return waited.inflight!.catch(() => undefined).then((): Promise<PeerGalleryState> | PeerGalleryState =>
			(entries.get(id) === waited ? readPeerGallery(readerHash, grant) : { state: 'superseded' }));
	}
	if (entry.inflight) return entry.inflight;

	const current = entry;
	const run = readOnce(id, current, key).finally(() => {
		if (current.inflight === run) current.inflight = null;
	});
	current.inflight = run;
	return run;
};

export const forgetPeerGalleryReads = (): void => {
	entries.clear();
};
