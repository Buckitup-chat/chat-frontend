// @vitest-environment jsdom
// The session signs as the account's notes identity and the peers of its
// notes (pq_notes_to_self.proposed.md § Writing as the notes identity). Their
// writes queue in the account's outbox, and every request is proven by the
// author of its rows, as the server checks: never by the account for them.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { accountNotes } from '@buckitup/pq-client/notes';
import { signedUserCard } from '@buckitup/pq-client/derivedIdentity';
import { verifyUserCard } from '@buckitup/pq-client/verifyCard';
import { fromBase64 } from '@buckitup/pq-client/signature';
import * as harness from './helpers/twoClients';
import type { Client } from './helpers/twoClients';

const { server, net, goOnline, register, signIn, stopAll, newClient, proofIsValid } = harness;

vi.mock('@lo-fi/local-vault', async () => (await import('./helpers/twoClients')).vaultModule);
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('vue-router', async () => {
	const { route } = await import('./helpers/twoClients');
	return {
		useRoute: () => ({ params: { get address() { return route.peer; } }, query: {} }),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	};
});

const NOTE_ID = '00112233445566778899aabbccddeeff';
const NOTES = { kind: 'notes' } as const;
const PEER = { kind: 'note-peer', noteId: NOTE_ID } as const;

/** What every module of the running app sees: the client's session after startApp. */
const session = async () => {
	const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
	const em = EncryptionManagerPQ.getInstance();
	const accountKey = async () => fromBase64((await em.exportVaultKeys()).sign_skey);
	const { ensureDerivedCard } = await import('@/lib/notes/derivedCard');
	return {
		em,
		accountKey,
		ids: await import('@/lib/data/sessionIdentities'),
		/** Publishes `signer`'s card as the app does. */
		publish: (signer: typeof NOTES | typeof PEER, verifiedCard?: (userHash: string) => Promise<string | null>) =>
			ensureDerivedCard(signer, em.derivedCard(signer), accountKey, verifiedCard),
		/** The account's notes, derived outside the session: what another device of the account derives. */
		notes: async () => {
			const keys = await em.exportVaultKeys();
			return accountNotes({ signSkey: fromBase64(keys.sign_skey), cryptSkey: fromBase64(keys.crypt_skey) });
		},
	};
};

const proofsBy = (author: string) => server.proofs.filter((p) => p.author === author).map((p) => ({ author: p.author, valid: proofIsValid(p) }));
const accepted = async (handle: Awaited<ReturnType<Awaited<ReturnType<typeof session>>['publish']>>) => {
	expect(handle).not.toBe('present');
	if (handle !== 'present') expect((await handle.acceptance).kind).toBe('accepted');
};

let A: Client;
beforeEach(() => {
	server.reset();
	net.mode = 'online';
	A = newClient('Alice');
});
afterEach(() => stopAll());

describe('the notes identity in the session', () => {
	it('is derived at sign-in, the same as on any device of the account, and gone at logout', async () => {
		await register(A);
		const { em, ids, notes } = await session();
		expect(em.notesUserHash).toBe((await notes()).identity.userHash);
		expect(ids.derivedSigner(A.hash, NOTES).userHash).toBe(em.notesUserHash);

		await A.app.store.logout();
		expect(em.notesUserHash).toBeNull();
		expect(() => ids.derivedSigner(A.hash, NOTES)).toThrow(/not open/);
	});

	it('publishes its card proven by itself, never by the account', async () => {
		await register(A);
		const { em, publish } = await session();
		const notesHash = em.notesUserHash;
		await accepted(await publish(NOTES));

		expect(verifyUserCard(server.table('user_cards').get(notesHash)!).status).toBe('verified');
		expect(proofsBy(notesHash)).toEqual([{ author: notesHash, valid: true }]);
		// every request was proven by its rows' author
		expect(server.proofs.every(proofIsValid)).toBe(true);
		// a second call finds it
		expect(await publish(NOTES)).toBe('present');
	});

	it('queues a write offline in the account\'s outbox, and replays it after a new sign-in, proven by the notes identity', async () => {
		await register(A);
		let { em, publish } = await session();
		const notesHash = em.notesUserHash;

		net.mode = 'offline';
		// the live attempt fails for want of a connection; the write is stored
		await publish(NOTES).catch(() => {});
		const pending = await A.app.outbox.pendingEntries(A.hash);
		expect(pending.map((e) => [e.userHash, e.signer])).toEqual([[A.hash, NOTES]]);
		expect(server.table('user_cards').has(notesHash)).toBe(false);

		await signIn(A);
		({ em, publish } = await session());
		goOnline();
		await vi.waitFor(() => expect(server.table('user_cards').has(notesHash)).toBe(true), { timeout: 15_000, interval: 100 });
		expect(proofsBy(notesHash).at(-1)).toEqual({ author: notesHash, valid: true });
	}, 30_000);

	it('counts another device\'s card of the same identity as its own', async () => {
		await register(A);
		const { em, publish, notes } = await session();
		// another device of the account published first, with its own signature and timestamp
		server.table('user_cards').set(em.notesUserHash, signedUserCard((await notes()).identity, 1_700_000_000));

		// it raced: the card was not seen when this device decided to publish
		await accepted(await publish(NOTES, async () => null));
		expect(await A.app.outbox.quarantinedEntries(A.hash)).toEqual([]);
	});
});

describe('a note peer', () => {
	it('queued in an earlier session, goes in the next one without the note being opened there', async () => {
		await register(A);
		let { em, publish } = await session();
		const peerHash = em.notePeerHash(NOTE_ID);
		net.mode = 'offline';
		await publish(PEER).catch(() => {});

		// a new session, which has not looked at the note: it derives the peer from the entry
		await signIn(A);
		({ em, publish } = await session());
		goOnline();
		await vi.waitFor(() => expect(server.table('user_cards').has(peerHash)).toBe(true), { timeout: 15_000, interval: 100 });
		expect(proofsBy(peerHash)).toEqual([{ author: peerHash, valid: true }]);
		expect(await A.app.outbox.quarantinedEntries(A.hash)).toEqual([]);
	}, 30_000);
});

describe('the account\'s outbox', () => {
	it('never proves rows the account did not write and no identity of it signed, nor a signer\'s entry whose rows are another\'s', async () => {
		await register(A);
		const { em, notes } = await session();
		const { enqueue } = A.app.outbox;
		const peer = (await notes()).peer(NOTE_ID);
		const card = (row: ReturnType<typeof signedUserCard>) => [{ type: 'insert', syncMetadata: { relation: 'user_cards' }, modified: row }];

		net.mode = 'offline';
		await enqueue(card(signedUserCard(peer, 1_700_000_000)), A.hash);
		await enqueue(card(signedUserCard(peer, 1_700_000_001)), A.hash, { signer: NOTES });
		goOnline();
		const { drainPendingWrites } = await import('@/lib/data/ingest');
		drainPendingWrites(A.hash, async () => fromBase64((await em.exportVaultKeys()).sign_skey));

		await vi.waitFor(async () => expect(await A.app.outbox.quarantinedEntries(A.hash)).toHaveLength(2), { timeout: 15_000, interval: 100 });
		expect(proofsBy(peer.userHash)).toEqual([]);
		expect(server.table('user_cards').has(peer.userHash)).toBe(false);
	}, 30_000);
});
