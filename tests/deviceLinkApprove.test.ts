// @vitest-environment jsdom
// The device that has the account shows the code without its middle pair and
// sends only after the person types that pair from the new device.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import {
	createOffer, encodeInvite, openOffer, verifyCommand, encodeBytes, decodeBytes,
	type LinkOffer, type LinkSession,
} from '@buckitup/pq-client/deviceLink';
import { splitSas } from '@/lib/deviceLink/sas';

(globalThis as { API_URL?: string }).API_URL = 'http://relay.test';

type Handler = (data: unknown, from: string) => void;
const room = vi.hoisted(() => ({ sent: [] as unknown[], onMessage: null as null | ((data: unknown, from: string) => void) }));

vi.mock('@/lib/deviceLink/room', () => ({
	roomSocketUrl: () => 'ws://relay.test',
	joinRoom: async () => ({
		send: (data: unknown) => room.sent.push(data),
		onMessage: (h: Handler) => (room.onMessage = h),
		onJoin: () => {},
		onLeave: () => {},
		onClose: () => {},
		close: () => {},
	}),
}));
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({
		currentUser: { name: 'Alice', user_hash: 'u_alice' },
		exportBackup: async () => ({ version: 1, identity: { user_hash: 'u_alice' }, keys: {} }),
	}),
}));
vi.mock('qr-scanner', () => ({ default: class {} }));

const { default: Approve } = await import('@/components/modal/views/Modal_Link_Approve.vue');

enableAutoUnmount(afterEach);
afterEach(() => {
	room.sent.length = 0;
	room.onMessage = null;
});

/** Mount the screen, paste the new device's code and play the new device's offer. */
const reachConfirm = async (w = mount(Approve, { global: { provide: { $mitt: { emit: () => {} } } } })) => {
	const offer: LinkOffer = createOffer();
	room.sent.length = 0;
	await w.find('input').setValue(encodeInvite(offer));
	await w.findAll('button').find((b) => b.text() === 'Continue')!.trigger('click');
	await flushPromises();
	room.onMessage!({ kind: 'offer', kemPublicKey: encodeBytes(offer.kemPublicKey) }, 'new');
	await flushPromises();
	const accept = room.sent[0] as { kind: string; cipherText: string };
	expect(accept.kind).toBe('accept');
	const peer: LinkSession = openOffer(offer, decodeBytes(accept.cipherText));
	return { w, peer, middle: splitSas(peer.sas).middle };
};

const type = async (w: ReturnType<typeof mount>, digits: string) => {
	await w.find('[data-test="link-sas-digits"]').setValue(digits);
	await w.findAll('button').find((b) => b.text() === 'The codes match — send')!.trigger('click');
	await flushPromises();
};

const commands = (peer: LinkSession) =>
	room.sent.map((m) => verifyCommand(peer, m as never)).filter(Boolean).map((c) => (c as { kind: string }).kind);

const otherPair = (middle: string) => String((Number(middle) + 1) % 100).padStart(2, '0');

describe('device link: the sending device', () => {
	it('shows the code without its middle pair', async () => {
		const { w, peer } = await reachConfirm();
		const { head, tail } = splitSas(peer.sas);
		expect(w.find('[data-test="link-sas"]').text().replace(/\s/g, '')).toBe(head + tail);
	});

	it('sends the account once the middle digits are typed', async () => {
		const { w, peer, middle } = await reachConfirm();
		await type(w, middle);
		// Sealing runs in WebCrypto, past what flushPromises waits for.
		await vi.waitFor(() => expect(commands(peer)).toEqual(['backup']));
	});

	it('sends nothing for a wrong pair and lets the person retry', async () => {
		const { w, peer, middle } = await reachConfirm();
		await type(w, otherPair(middle));
		expect(commands(peer)).toEqual([]);
		expect(w.text()).toContain('These are not the middle digits');
		await type(w, middle);
		await vi.waitFor(() => expect(commands(peer)).toEqual(['backup']));
	});

	it('aborts the link on the third wrong pair', async () => {
		const { w, peer, middle } = await reachConfirm();
		for (let i = 0; i < 3; i++) await type(w, otherPair(middle));
		expect(commands(peer)).toEqual(['abort']);
		expect(w.text()).toContain('Nothing was sent');
	});

	it('gives the next link all its attempts after Start over', async () => {
		const first = await reachConfirm();
		for (let i = 0; i < 3; i++) await type(first.w, otherPair(first.middle));
		await first.w.findAll('button').find((b) => b.text() === 'Start over')!.trigger('click');
		const { w, peer, middle } = await reachConfirm(first.w);
		expect(w.text()).not.toContain('These are not the middle digits');
		await type(w, otherPair(middle));
		expect(commands(peer)).toEqual([]);
		await type(w, middle);
		await vi.waitFor(() => expect(commands(peer)).toEqual(['backup']));
	});
});
