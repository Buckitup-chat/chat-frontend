// @vitest-environment jsdom
// The checkpoint diff modal shows the changes themselves: word-level diff
// for edits, struck-through content for deletes, and a jump to the message.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CheckpointDiffModal from '@/components/chat/CheckpointDiffModal.vue';

const M1 = 'dmsg_1';
const M2 = 'dmsg_2';

const mountWith = (changes) =>
	mount(CheckpointDiffModal, { props: { createdAt: 1788470000, changes } });

describe('CheckpointDiffModal', () => {
	it('shows an edit as an in-text word diff, both directions', () => {
		const w = mountWith([{
			type: 'MESSAGE_EDITED', messageId: M1, authorName: 'Ирина',
			oldText: 'встреча в 19:00', newText: 'встреча в 19:30',
		}]);
		expect(w.find('.cd-tag').text()).toBe('edited');
		expect(w.find('del.cd-removed').text()).toBe('19:00');
		expect(w.find('mark.cd-added').text()).toBe('19:30');
		expect(w.text()).toContain('Ирина');
	});

	it('shows what a deleted message said, struck through', () => {
		const w = mountWith([{ type: 'MESSAGE_DELETED', messageId: M1, oldText: 'это удалили' }]);
		expect(w.find('del.cd-removed').text()).toBe('это удалили');
	});

	it('shows added content and the change count', () => {
		const w = mountWith([
			{ type: 'MESSAGE_ADDED', messageId: M1, newText: 'новое сообщение' },
			{ type: 'MESSAGE_ADDED', messageId: M2, newText: '🖼 фото.jpg' },
		]);
		expect(w.text()).toContain('новое сообщение');
		expect(w.text()).toContain('🖼 фото.jpg');
		expect(w.find('.cd-sub').text()).toContain('2 changes');
	});

	it('a change row jumps to its message', async () => {
		const w = mountWith([{ type: 'MESSAGE_ADDED', messageId: M2, newText: 'x' }]);
		await w.find('.cd-change').trigger('click');
		expect(w.emitted('jump')[0]).toEqual([M2]);
	});

	it('shows a restored message and names the restoration', () => {
		const w = mountWith([{ type: 'MESSAGE_RESTORED', messageId: M1, newText: 'снова тут' }]);
		expect(w.find('.cd-tag').text()).toBe('restored');
		expect(w.text()).toContain('снова тут');
	});

	// MESSAGE_REMOVED is the one change type that means local state LOST a
	// row the checkpoint attested — it must render as that warning, not
	// disappear into a generic row.
	it('a removed message renders as missing from local state', () => {
		const w = mountWith([{ type: 'MESSAGE_REMOVED', messageId: M1 }]);
		expect(w.find('.cd-tag').text()).toBe('missing');
		expect(w.text()).toContain('was present at the checkpoint, missing from local state now');
	});

	it('says so when nothing changed', () => {
		const w = mountWith([]);
		expect(w.text()).toContain('Nothing changed.');
		expect(w.find('.cd-sub').text()).toContain('no changes');
	});

	// The overlay is position:fixed over the whole screen; the ✕ and the
	// backdrop are its only two exits.
	it('closes from the ✕ button', async () => {
		const w = mountWith([]);
		await w.find('.cd-close').trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('closes from the backdrop but not from the card body', async () => {
		const w = mountWith([]);
		await w.find('.cd-card').trigger('click');
		expect(w.emitted('close')).toBeUndefined();
		await w.find('.cd-modal').trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('future messages collapse into one marker that jumps to the first', async () => {
		const w = mount(CheckpointDiffModal, {
			props: {
				createdAt: 1788470000,
				changes: [{ type: 'MESSAGE_EDITED', messageId: M1, oldText: 'a', newText: 'b' }],
				futureAdded: { count: 57, firstMessageId: M2 },
			},
		});
		const future = w.find('.cd-change._future');
		expect(future.text()).toContain('57 new messages since the checkpoint');
		// exactly two rows: the detailed past change and the single marker
		expect(w.findAll('.cd-change')).toHaveLength(2);
		expect(w.find('.cd-sub').text()).toContain('1 change to attested history · 57 new after');
		await future.trigger('click');
		expect(w.emitted('jump')[0]).toEqual([M2]);
	});
});
