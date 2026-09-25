// The contacts slot keeps what a contact is, on every write: whether it was
// confirmed in person — the only kind a recovery share may go to — and the key
// its handshake exchanged. A write edits the list the server holds, so neither
// another tab's change nor a list this tab never loaded is written over.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

class FakeEM extends EventTarget {
	#userHash = null;
	/** The contacts slot as the server holds it; null until written. */
	stored = null;
	get currentUserHash() { return this.#userHash; }
	get isAuth() { return !!this.#userHash; }
	async initialize() {}
	async getLocalUserCards() { return []; }
	async loadContacts() { return this.stored ?? []; }
	async updateSlotJson(name, mutate) {
		if (name !== 'contacts') throw new Error(`unexpected slot ${name}`);
		this.stored = await mutate(this.stored);
		return this.stored;
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

const A = 'u_' + 'a'.repeat(128);
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

	it('keeps a contact confirmed in person as confirmed, and one added by id as not', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pkA', confirmed: true });
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		const last = fake.stored;
		expect(last.find((c) => c.user_hash === A)).toMatchObject({ confirmed: true, contact_pkey: 'pkA' });
		expect(last.find((c) => c.user_hash === B)).toMatchObject({ confirmed: false, contact_pkey: 'pkB' });
	});

	it('keeps every other contact whole when one is deleted', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pkA', confirmed: true });
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		await store.deleteContact(B);
		expect(fake.stored).toEqual([
			{ user_hash: A, name: 'Ann', notes: undefined, hidden: undefined, contact_pkey: 'pkA', confirmed: true },
		]);
	});

	it('keeps a confirmation another tab wrote after this one loaded', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pkA' });
		// The other tab scanned Ann in person; this tab's copy still says unconfirmed.
		fake.stored = fake.stored.map((c) => (c.user_hash === A ? { ...c, confirmed: true } : c));
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		expect(fake.stored.find((c) => c.user_hash === A)).toMatchObject({ confirmed: true });
		expect(store.contactsMap[A].confirmed).toBe(true);
	});

	it('adds to the list the server holds even when this tab never loaded it', async () => {
		fake.stored = [{ user_hash: A, name: 'Ann', contact_pkey: 'pkA', confirmed: true }];
		store.contactsMap = {};
		await store.saveContact(B, { name: 'Bob', contact_pkey: 'pkB' });
		expect(fake.stored.map((c) => c.user_hash).sort()).toEqual([A, B].sort());
	});

	it('does not unconfirm a contact when it is saved again without the flag', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pkA', confirmed: true });
		await store.saveContact(A, { hidden: true });
		expect(fake.stored.find((c) => c.user_hash === A)).toMatchObject({ confirmed: true, hidden: true });
	});

	it('confirms a contact added by id once it is scanned in person', async () => {
		await store.saveContact(A, { name: 'Ann', contact_pkey: 'pkA' });
		await store.saveContact(A, { confirmed: true });
		expect(fake.stored).toEqual([
			{ user_hash: A, name: 'Ann', notes: undefined, hidden: undefined, contact_pkey: 'pkA', confirmed: true },
		]);
	});
});
