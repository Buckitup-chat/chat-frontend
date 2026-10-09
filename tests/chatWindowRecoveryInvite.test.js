// @vitest-environment jsdom
// A guardian invitation renders as a card in its bubble, and its buttons are
// the only ways to answer (pq_recovery_shares § Inviting).
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const MY = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const INVITE = '11'.repeat(16);
const DEPLOYMENT = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';

const message = (over = {}) => ({
	id: 'dmsg_1',
	text: '🛡 guardian invitation',
	parts: [{ kind: 'recovery_invite', inviteId: INVITE, deployment: DEPLOYMENT }],
	authorName: 'Peer',
	isMine: false,
	timestamp: '10:00',
	_syncStatus: 'synced',
	_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: PEER, parent_sign_hash: null },
	...over,
});

const received = (over = {}) => ({ kind: 'received_invite', inviteId: INVITE, deployment: DEPLOYMENT, blocker: null, answer: null, ...over });

const render = (invites, props = {}) =>
	mount(ChatWindow, {
		props: { title: 'Ирина', myHash: MY, peerHash: PEER, messages: [message()], reactions: {}, invites, ...props },
		global: { stubs: { Avatar: true } },
	});

const buttons = (w) => w.findAll('.msg-invite button').map((b) => b.text());

describe('a received invitation', () => {
	it('says what is asked and by whom, in place of the label', () => {
		const w = render({ dmsg_1: received() });
		expect(w.find('.msg-invite').text()).toContain('Ирина asks you to be their guardian');
		expect(w.find('.message-text').exists()).toBe(false);
		expect(buttons(w)).toEqual(['Accept', 'Decline']);
	});

	it('answers through the page, naming the invitation', async () => {
		const w = render({ dmsg_1: received() });
		await w.findAll('.msg-invite button')[0].trigger('click');
		await w.findAll('.msg-invite button')[1].trigger('click');
		expect(w.emitted('answerInvite')).toEqual([
			[{ inviteId: INVITE, deployment: DEPLOYMENT, accept: true }],
			[{ inviteId: INVITE, deployment: DEPLOYMENT, accept: false }],
		]);
	});

	it('can only be declined from an unconfirmed contact or on an unreachable deployment', () => {
		for (const blocker of ['not_confirmed', 'unreachable']) {
			const w = render({ dmsg_1: received({ blocker }) });
			expect(buttons(w)).toEqual(['Decline']);
			expect(w.find('.msg-invite-warn').exists()).toBe(true);
		}
	});

	it('once accepted offers a withdrawal, and once declined nothing', () => {
		expect(buttons(render({ dmsg_1: received({ answer: 'accept' }) }))).toEqual(['Withdraw']);
		expect(buttons(render({ dmsg_1: received({ answer: 'decline' }) }))).toEqual([]);
	});
});

describe('the invite button', () => {
	it('shows only for a confirmed contact', async () => {
		const title = '[title="Ask to be your guardian"]';
		expect(render({}).find(title).exists()).toBe(false);
		const w = render({}, { canInvite: true });
		await w.find(title).trigger('click');
		expect(w.emitted('inviteGuardian')).toHaveLength(1);
	});
});

describe('a sent invitation', () => {
	it('shows its state and the replies it ignored', () => {
		const w = render({ dmsg_1: { kind: 'sent_invite', inviteId: INVITE, state: 'pending', problems: ['the proof is not by the meta-address\'s spending key'] } });
		expect(w.find('.msg-invite').text()).toContain('Waiting for their answer. Ignored: the proof');
		expect(buttons(w)).toEqual([]);
	});
});
