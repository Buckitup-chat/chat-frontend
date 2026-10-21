// The contacts slot keeps what a contact is, on every write: whether it was
// confirmed in person — the only kind a recovery share may go to — and the key
// its handshake exchanged. A write is a patch of the list the server holds, so
// neither another tab's change nor a list this tab never loaded is written over.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { makeTestIdentity, resignedCard } from './helpers/signedFixtures';

class FakeEM extends EventTarget {
	#userHash = null;
	/** The contacts slot as the server holds it; null until written. */
	stored = null;
	get list() { return Object.values(this.stored?.contacts ?? {}); }
	get currentUserHash() { return this.#userHash; }
	get isAuth() { return !!this.#userHash; }
	async initialize() {}
	async getLocalUserCards() { return []; }
	async loadContacts() { return this.list; }
	// The real merge, as the materializer lands the patch on the stored slot.
	async patchContacts(edits) {
		this.stored = stripPatchDirectives(mergeJsonPatch(this.stored, { contacts: edits }));
		return this.list;
	}
	async saveContacts(edits) {
		return { contacts: await this.patchContacts(edits), status: 'synced' };
	}
	fakeLogin(hash) {
		this.#userHash = hash;
		this.dispatchEvent(new CustomEvent('authChange', { detail: { isAuthenticated: true, userHash: hash } }));
	}
}

let fake;
// Whatever else sign-in asks of the manager answers nothing.
const manager = () =>
	new Proxy(fake, {
		get: (t, p) => {
			if (p in t) return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
			return async () => undefined;
		},
	});

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => manager() },
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({ toArray: [], async preload() {}, subscribeChanges: () => ({ unsubscribe() {} }) }),
}));
vi.mock('@/lib/data/attach', () => ({ preloadWithRetry: async () => false }));

const { userPQStore } = await import('@/store/userPQ.store');
const { mergeJsonPatch, stripPatchDirectives } = await import('@/lib/data/storageIntent');

// Ann has a real, self-signed card: confirmContact verifies the card it is given.
const ann = makeTestIdentity(31, 'Ann');
const annCard = ann.card;
const A = ann.userHash;
const pkA = annCard.contact_pkey;
const B = 'u_' + 'b'.repeat(128);

describe('the contacts slot', () => {
	let store;

	beforeEach(async () => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		store = userPQStore();
		await store.initialize();
		fake.fakeLogin('u_' + '1'.repeat(128));
	});

	it('confirms a contact only through confirmContact; saveContact ignores a confirmed field', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		// A view object mixing in network card fields must not confirm anyone.
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB', confirmed: true });
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true, contact_pkey: pkA });
		expect(fake.stored.contacts[B]).toMatchObject({ contact_pkey: 'pkB' });
		expect(fake.stored.contacts[B].confirmed).toBeFalsy();
	});

	it('keeps a contact confirmed in person as confirmed, and one added by id as not', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true, contact_pkey: pkA });
		expect(fake.stored.contacts[B]).toMatchObject({ contact_pkey: 'pkB' });
		expect(fake.stored.contacts[B].confirmed).toBeFalsy();
	});

	it('keeps every other contact whole when one is deleted', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		await store.deleteContact(B);
		expect(fake.list).toEqual([{ user_hash: A, name: 'Ann', contact_pkey: pkA, confirmed: true, confirmedAt: expect.any(Number) }]);
	});

	it('keeps a confirmation another tab wrote after this one loaded', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
		// The other tab scanned Ann in person; this tab's copy still says unconfirmed.
		fake.stored.contacts[A] = { ...fake.stored.contacts[A], confirmed: true };
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true });
		expect(store.contactsMap[A].confirmed).toBe(true);
	});

	it('adds to the list the server holds even when this tab never loaded it', async () => {
		fake.stored = { contacts: { [A]: { user_hash: A, name: 'Ann', contact_pkey: pkA, confirmed: true } } };
		store.contactsMap = {};
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		expect(fake.list.map((c) => c.user_hash).sort()).toEqual([A, B].sort());
	});

	it('does not unconfirm a contact when it is saved again without the flag', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		await store.saveContact(A, { hidden: true });
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true, hidden: true });
	});

	it('does not carry a deleted contact\'s confirmation into one added again before either is sent', async () => {
		const { mergeJsonPatch: merge, stripPatchDirectives: strip } = await import('@/lib/data/storageIntent');
		const stored = { contacts: { [A]: { user_hash: A, name: 'Ann', contact_pkey: pkA, confirmed: true } } };
		// Two unsent patches of the slot coalesce before either is signed.
		const coalesced = merge({ contacts: { [A]: null } }, { contacts: { [A]: { user_hash: A, name: 'Ann again', contact_pkey: 'pkA2' } } });
		expect(strip(merge(stored, coalesced)).contacts).toEqual({ [A]: { user_hash: A, name: 'Ann again', contact_pkey: 'pkA2' } });
	});

	it('confirms a contact added by id once it is scanned in person, with the key the handshake proved', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pk-from-the-network' });
		await store.confirmContact(A, annCard, pkA);
		expect(fake.list).toEqual([{ user_hash: A, name: 'Ann', contact_pkey: pkA, confirmed: true, confirmedAt: expect.any(Number) }]);
	});

	it('refuses a card that is not a verified card of the contact, and writes nothing', async () => {
		const bob = makeTestIdentity(32, 'Bob');
		const refused = [
			null,
			bob.card, // another identity's card
			{ ...annCard, name: 'Ann (edited)' }, // its signature no longer covers it
			resignedCard(ann, { contact_pkey: bob.card.contact_pkey }), // a key Ann's identity never certified
		];
		for (const card of refused) {
			await expect(store.confirmContact(A, card, pkA, { name: 'Ann' })).rejects.toThrow(/cannot be confirmed/);
		}
		// Ann's own, valid card, but the key shown in person is someone else's: Mallory showing Ann's user_hash.
		await expect(store.confirmContact(A, annCard, bob.card.contact_pkey, { name: 'Ann' })).rejects.toThrow(/cannot be confirmed/);
		await expect(store.confirmContact(A, annCard, undefined, { name: 'Ann' })).rejects.toThrow(/cannot be confirmed/);
		// Ann's account deleted: its last card verifies and certifies the key, and still confirms nothing.
		await expect(store.confirmContact(A, resignedCard(ann, { deleted_flag: true }), pkA, { name: 'Ann' })).rejects.toThrow(/account is deleted/);
		expect(fake.stored).toBeNull();
		expect(store.contactsMap[A]).toBeUndefined();
	});

	it('stores the key proved in person and stamps the confirmation; the caller\'s fields set neither', async () => {
		const before = Math.floor(Date.now() / 1000);
		await store.confirmContact(A, annCard, pkA, { name: 'Ann', contact_pkey: 'pk-from-the-caller', confirmed: false, confirmedAt: 1 });
		const saved = fake.stored.contacts[A];
		expect(saved).toMatchObject({ name: 'Ann', contact_pkey: pkA, confirmed: true });
		expect(saved.confirmedAt).toBeGreaterThanOrEqual(before);
		await store.saveContact(A, { name: 'Ann', confirmedAt: 1 });
		expect(fake.stored.contacts[A].confirmedAt).toBe(saved.confirmedAt);
	});

	it('takes the confirmation away when a save changes the contact\'s key, and keeps it when the key stays', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		await store.saveContact(A, { name: 'Ann', contact_pkey: pkA, notes: 'met at the café' });
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true, notes: 'met at the café' });
		await store.saveContact(A, { contact_pkey: 'pk-someone-said-is-new' });
		expect(fake.stored.contacts[A].confirmed).toBeUndefined();
		expect(fake.stored.contacts[A].confirmedAt).toBeUndefined();
		expect(store.contactsMap[A].confirmed).toBeUndefined();
	});

	it('takes the confirmation away against the stored contact, not this tab\'s copy', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pk-old' });
		// Another tab confirmed Ann in person with her card's key; this tab still shows the old key, unconfirmed.
		fake.stored.contacts[A] = { ...fake.stored.contacts[A], contact_pkey: pkA, confirmed: true, confirmedAt: 5 };
		await store.saveContact(A, { contact_pkey: pkA });
		expect(fake.stored.contacts[A]).toMatchObject({ contact_pkey: pkA, confirmed: true, confirmedAt: 5 });
		await store.saveContact(A, { contact_pkey: 'pk-old' });
		expect(fake.stored.contacts[A].confirmed).toBeUndefined();
	});

	it('shows an edit at once, and does not let an older write\'s answer undo a newer edit', async () => {
		let release;
		const slow = new Promise((r) => { release = r; });
		const realPatch = fake.patchContacts.bind(fake);
		let calls = 0;
		fake.patchContacts = async (edits) => (++calls === 1 ? slow.then(() => realPatch(edits)) : realPatch(edits));
		const first = store.saveContact(A, { name: 'An' });
		expect(store.contactsMap[A].name).toBe('An');
		await store.saveContact(A, { name: 'Ann' });
		release();
		await first;
		expect(store.contactsMap[A].name).toBe('Ann');
	});

	it('clears the contacts on logout, so the next account does not see them', async () => {
		await store.saveContact(A, { name: 'Ann' });
		await store.logout();
		expect(store.contactsMap).toEqual({});
	});
	describe('a contacts write the server does not take', () => {
		// Holds the next patch until the test settles it: fail() rejects it,
		// pass() lets it land on the stored slot as the real merge would.
		const holdNextPatch = () => {
			const realPatch = fake.patchContacts.bind(fake);
			let settle;
			const held = new Promise((resolve) => { settle = resolve; });
			let taken = false;
			fake.patchContacts = async (edits) => {
				if (taken) return realPatch(edits);
				taken = true;
				const outcome = await held;
				if (outcome.error) throw outcome.error;
				return realPatch(edits);
			};
			return { fail: (error) => settle({ error }), pass: () => settle({}) };
		};

		it('rejects with the error and takes the edit back: an unconfirmed contact does not show as confirmed', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			const held = holdNextPatch();
			const write = store.confirmContact(A, annCard, pkA);
			expect(store.contactsMap[A].confirmed).toBe(true); // shown at once
			const error = new Error('the server refused the write');
			held.fail(error);
			await expect(write).rejects.toBe(error);
			expect(store.contactsMap[A]).toEqual({ user_hash: A, name: 'Ann', contact_pkey: pkA });
			expect(fake.stored.contacts[A].confirmed).toBeUndefined();
		});

		it('takes back a new contact that was never saved', async () => {
			const held = holdNextPatch();
			const write = store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
			expect(store.contactsMap[B]).toBeTruthy();
			held.fail(new Error('offline'));
			await expect(write).rejects.toThrow('offline');
			expect(store.contactsMap[B]).toBeUndefined();
		});

		it('does not undo a newer edit of the same contact that is still out, and hands it what to go back to', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			const older = holdNextPatch();
			const first = store.saveContact(A, { name: 'An' });
			const newer = holdNextPatch();
			const second = store.saveContact(A, { name: 'Anna' });
			older.fail(new Error('lost'));
			await expect(first).rejects.toThrow('lost');
			expect(store.contactsMap[A].name).toBe('Anna'); // the newer edit still shows
			newer.fail(new Error('lost too'));
			await expect(second).rejects.toThrow('lost too');
			expect(store.contactsMap[A].name).toBe('Ann'); // neither was saved
		});

		it('rolls back when newer and older writes fail in reverse order', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			expect(fake.stored.contacts[A].name).toBe('Ann');
			expect(store.contactsMap[A].name).toBe('Ann');
			const older = holdNextPatch();
			const first = store.saveContact(A, { name: 'An' });
			const newer = holdNextPatch();
			const second = store.saveContact(A, { name: 'Anna' });
			expect(store.contactsMap[A].name).toBe('Anna');

			newer.fail(new Error('newer lost'));
			await expect(second).rejects.toThrow('newer lost');
			expect(store.contactsMap[A].name).toBe('An'); // the older write is still out

			older.fail(new Error('older lost'));
			await expect(first).rejects.toThrow('older lost');
			expect(store.contactsMap[A].name).toBe('Ann'); // neither was saved
		});

		it('does not undo an edit of the same contact the server has taken since', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			const older = holdNextPatch();
			const first = store.saveContact(A, { name: 'An' });
			await store.saveContact(A, { name: 'Anna' });
			older.fail(new Error('lost'));
			await expect(first).rejects.toThrow('lost');
			expect(store.contactsMap[A].name).toBe('Anna');
		});

		it('takes back only its own contact when another contact\'s edit is still out', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			const older = holdNextPatch();
			const first = store.confirmContact(A, annCard, pkA);
			const newer = holdNextPatch();
			const second = store.saveContact(B, { name: 'Bob' });
			older.fail(new Error('lost'));
			await expect(first).rejects.toThrow('lost');
			expect(store.contactsMap[A].confirmed).toBeUndefined();
			expect(store.contactsMap[B].name).toBe('Bob');
			newer.pass();
			await second;
			expect(store.contactsMap[A].confirmed).toBeUndefined();
			expect(store.contactsMap[B].name).toBe('Bob');
		});

		describe('two edits of one contact, both held: Ann → An → Anna', () => {
			// The first edit's answer is held, then the second's; the test settles
			// them in the order under test.
			const twoEdits = async () => {
				await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
				const older = holdNextPatch();
				const first = store.saveContact(A, { name: 'An' });
				const newer = holdNextPatch();
				const second = store.saveContact(A, { name: 'Anna' });
				expect(store.contactsMap[A].name).toBe('Anna');
				return { older, first, newer, second };
			};

			it('both fail, older first: back to Ann', async () => {
				const { older, first, newer, second } = await twoEdits();
				older.fail(new Error('older lost'));
				await expect(first).rejects.toThrow('older lost');
				expect(store.contactsMap[A].name).toBe('Anna'); // the newer edit is still out
				newer.fail(new Error('newer lost'));
				await expect(second).rejects.toThrow('newer lost');
				expect(store.contactsMap[A].name).toBe('Ann');
				expect(fake.stored.contacts[A].name).toBe('Ann');
			});

			it('both fail, newer first: back to Ann', async () => {
				const { older, first, newer, second } = await twoEdits();
				newer.fail(new Error('newer lost'));
				await expect(second).rejects.toThrow('newer lost');
				expect(store.contactsMap[A].name).toBe('An'); // the older edit is still out
				older.fail(new Error('older lost'));
				await expect(first).rejects.toThrow('older lost');
				expect(store.contactsMap[A].name).toBe('Ann');
				expect(fake.stored.contacts[A].name).toBe('Ann');
			});

			it('the newer is taken, the older fails later: Anna stays', async () => {
				const { older, first, newer, second } = await twoEdits();
				newer.pass();
				await second;
				expect(store.contactsMap[A].name).toBe('Anna');
				older.fail(new Error('older lost'));
				await expect(first).rejects.toThrow('older lost');
				expect(store.contactsMap[A].name).toBe('Anna');
				expect(fake.stored.contacts[A].name).toBe('Anna');
			});

			it('the newer fails, the older is taken: An stays, as the server holds', async () => {
				const { older, first, newer, second } = await twoEdits();
				newer.fail(new Error('newer lost'));
				await expect(second).rejects.toThrow('newer lost');
				expect(store.contactsMap[A].name).toBe('An');
				older.pass();
				await first;
				expect(store.contactsMap[A].name).toBe('An');
				expect(fake.stored.contacts[A].name).toBe('An');
			});

			it('after an account switch, neither failure puts anything back', async () => {
				const { older, first, newer, second } = await twoEdits();
				await store.logout();
				fake.fakeLogin('u_' + '2'.repeat(128));
				fake.stored = null; // the next account's own contacts slot
				await store.saveContact(B, { name: 'Bob' });
				newer.fail(new Error('newer lost'));
				await expect(second).rejects.toThrow('newer lost');
				older.fail(new Error('older lost'));
				await expect(first).rejects.toThrow('older lost');
				expect(store.contactsMap).toEqual({ [B]: { user_hash: B, name: 'Bob' } });
			});
		});

		it('does not bring the previous account\'s contacts back after a switch', async () => {
			await store.saveContact(A, { name: 'Ann', contact_pkey: pkA });
			const held = holdNextPatch();
			const write = store.saveContact(A, { name: 'An' });
			await store.logout();
			fake.fakeLogin('u_' + '2'.repeat(128));
			held.fail(new Error('the account changed'));
			await expect(write).rejects.toThrow('the account changed');
			expect(store.contactsMap).toEqual({});
		});
	});
});

// pq_avatars § What a reader keeps: a contact's current photo, cached next to
// the contact so the list can draw it without reading every dialog.
describe('the cached avatar of a contact', () => {
	let store;
	const cached = { id: 'c'.repeat(32), photo: { image: [1, 1, '', 'a.jpg', 1, 'image/jpeg', 0, 'f_1', 'k'] } };

	beforeEach(async () => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		store = userPQStore();
		await store.initialize();
		fake.fakeLogin('u_' + '1'.repeat(128));
	});

	it('is kept next to the contact, and a save of the contact leaves it', async () => {
		await store.confirmContact(A, annCard, pkA, { name: 'Ann' });
		expect(await store.cacheContactAvatar(A, cached)).toBe(true);
		expect(fake.stored.contacts[A]).toMatchObject({ confirmed: true, avatar: cached });
		// A view object carries the cache back in; a save writes only what a contact is.
		await store.saveContact(A, { ...store.contactsMap[A], name: 'Anna', avatar: 'data:forged' });
		expect(fake.stored.contacts[A]).toMatchObject({ name: 'Anna', avatar: cached });
	});

	it('is replaced whole by the next one, and cleared with null', async () => {
		await store.saveContact(A, { name: 'Ann' });
		await store.cacheContactAvatar(A, cached);
		await store.cacheContactAvatar(A, { id: 'd'.repeat(32), photo: { inline_image: [1, 1, '', 'b.jpg', 1, 'image/jpeg', 0, 'AA'] } });
		expect(fake.stored.contacts[A].avatar.photo).toEqual({ inline_image: [1, 1, '', 'b.jpg', 1, 'image/jpeg', 0, 'AA'] });
		await store.cacheContactAvatar(A, null);
		expect(fake.stored.contacts[A].avatar).toBeNull();
	});

	it('does not make someone a contact', async () => {
		expect(await store.cacheContactAvatar(B, cached)).toBe(false);
		expect(fake.stored).toBeNull();
	});
});
