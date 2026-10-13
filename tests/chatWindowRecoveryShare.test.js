// @vitest-environment jsdom
// A backup piece renders as a card in its bubble, with its state and a Give
// back button while it is kept; a guardian's report renders as a service line
// (pq_recovery_shares § Holding).
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);

const message = (over = {}) => ({
	id: 'dmsg_1',
	text: '🔐 recovery share',
	parts: [{ kind: 'recovery_share' }],
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	_syncStatus: 'synced',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
	...over,
});
const kept = (over = {}) => ({ kind: 'kept_share', key: 'k1', state: 'stored', detail: '', version: 2, shareIndex: 3, canGiveBack: true, ...over });

const render = (shares, props = {}) =>
	mount(ChatWindow, {
		props: { title: 'Daria', myHash: MY, peerHash: PEER, messages: [message()], reactions: {}, shares, ...props },
		global: { stubs: { Avatar: true } },
	});
const state = (w) => w.find('[data-test="share-state"]').text();

describe('a kept piece', () => {
	it('says whose piece it is and where it stands, in place of the label', () => {
		const w = render({ dmsg_1: kept() });
		expect(w.find('[data-test="share-card"]').text()).toContain("🔐 Daria's backup piece");
		expect(w.find('[data-test="share-card"]').text()).toContain('Version 2 · piece 3');
		expect(state(w)).toBe('stored ✓');
		expect(w.find('.message-text').exists()).toBe(false);
	});

	it('names each state', () => {
		const cases = [
			[{ state: 'saving' }, 'saving…'],
			[{ state: 'pending' }, 'waiting for the network'],
			[{ state: 'unverified', detail: 'the share does not match its leaf' }, 'problem: the share does not match its leaf'],
			[{ state: 'unreachable' }, 'problem: its network is one this app cannot reach'],
			[{ state: 'conflict', detail: 'this piece was already sent with different contents', canGiveBack: false }, 'refused: this piece was already sent with different contents'],
			[{ state: 'given_back', canGiveBack: false }, 'given back'],
			[{ state: 'dropped', detail: 'the backup was revoked', canGiveBack: false }, 'dropped: the backup was revoked'],
		];
		for (const [over, text] of cases) expect(state(render({ dmsg_1: kept(over) }))).toBe(text);
	});

	it('asks the page to give it back, naming the holding, and offers nothing once it is gone', async () => {
		const w = render({ dmsg_1: kept() });
		await w.find('[data-test="give-back"]').trigger('click');
		expect(w.emitted('giveBackShare')).toEqual([['k1']]);
		expect(render({ dmsg_1: kept({ state: 'given_back', canGiveBack: false }) }).find('[data-test="give-back"]').exists()).toBe(false);
		expect(render({ dmsg_1: kept() }, { givingBack: true }).find('[data-test="give-back"]').attributes('disabled')).toBeDefined();
	});
});

describe('a piece this account sent', () => {
	it('shows what the guardian said, with a prompt to reshare when it no longer counts', () => {
		const sent = (over) => render({ dmsg_1: { kind: 'sent_share', state: 'stored', detail: '', version: 1, ...over } }, { messages: [message({ isMine: true })] });
		expect(sent().find('[data-test="share-card"]').text()).toContain('🔐 Your backup piece for Daria');
		expect(state(sent())).toBe('They stored it ✓');
		const back = sent({ state: 'given_back' });
		expect(state(back)).toBe('They gave it back');
		expect(back.text()).toContain('A reshare replaces this piece.');
		expect(state(sent({ state: null }))).toBe('Sent');
		expect(sent().find('[data-test="give-back"]').exists()).toBe(false);
	});
});

describe('a guardian’s report', () => {
	const line = (view, props) => render({ dmsg_1: { kind: 'holding', mine: false, detail: '', ...view } }, props).find('[data-test="holding-line"]').text();

	it('tells the owner what the guardian did with the piece', () => {
		expect(line({ state: 'stored' })).toBe('🔐 Daria stored your backup piece');
		expect(line({ state: 'given_back' })).toBe('🔐 Daria gave your backup piece back');
		expect(line({ state: 'unverified', detail: 'the share does not match its leaf' })).toBe('🔐 Daria could not verify your backup piece: the share does not match its leaf');
		expect(line({ state: 'dropped', detail: 'the backup was revoked' })).toBe('🔐 Daria no longer keeps your backup piece: the backup was revoked');
	});

	it('tells the guardian what they said', () => {
		expect(line({ state: 'stored', mine: true })).toBe("🔐 You stored Daria's backup piece");
		expect(line({ state: 'given_back', mine: true })).toBe("🔐 You gave Daria's backup piece back");
	});
});
