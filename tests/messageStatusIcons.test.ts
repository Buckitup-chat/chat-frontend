// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import type { VueWrapper } from '@vue/test-utils';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

const render = (over: Record<string, unknown>) =>
	mount(ChatWindow, {
		props: {
			title: 'Peer',
			reactions: {},
			messages: [{ id: 'dmsg_' + '1'.repeat(128), text: 'hi', authorName: 'Me', isMine: true, timestamp: '10:00', ...over }],
		},
		global: { stubs: { Avatar: true } },
	});

const marker = (w: VueWrapper) => w.find('.message-time .sync-status');

describe('message delivery marker', () => {
	it('a durably queued message waiting for retry is pending, not the red "!"', () => {
		const w = render({ _syncStatus: 'queued', _optimistic: true });
		expect(marker(w).text()).toBe('↻');
		expect(marker(w).classes()).not.toContain('error');
		expect(marker(w).attributes('title')).toMatch(/retry/i);
	});

	it('waiting for the vault to unlock has its own marker, not an error or a retry', () => {
		const w = render({ _syncStatus: 'awaiting_unlock', _optimistic: true });
		expect(marker(w).text()).toBe('🔒');
		expect(marker(w).attributes('title')).toBe('Waiting for unlock');
		expect(marker(w).classes()).not.toContain('error');
	});

	it('an intent kept for recovery before reaching the outbox is ↻, not "!", and does not claim to be queued', () => {
		const w = render({ _syncStatus: 'awaiting_recovery', _optimistic: true });
		expect(marker(w).text()).toBe('↻');
		expect(marker(w).classes()).not.toContain('error');
		expect(marker(w).attributes('title')).toMatch(/not sent yet/i);
		expect(marker(w).attributes('title')).not.toMatch(/queued/i);
	});

	it('a permanently rejected message shows the red "!"', () => {
		const w = render({ _syncStatus: 'error', _optimistic: true });
		expect(marker(w).text()).toBe('!');
		expect(marker(w).classes()).toContain('error');
	});

	it('SERVER_ACCEPTED shows one check', () => {
		const w = render({ _syncStatus: 'synced' });
		expect(marker(w).text()).toBe('✓');
		expect(marker(w).classes()).toContain('synced');
	});

	it('a delivery receipt shows two checks', () => {
		const w = render({ _syncStatus: 'synced', _deliveredToPeers: 1 });
		expect(marker(w).text()).toBe('✓✓');
		expect(marker(w).classes()).toContain('delivered');
	});
});
