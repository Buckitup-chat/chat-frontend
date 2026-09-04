// @vitest-environment jsdom
// Screen 06: versions top-down, the current one barred, differences
// highlighted inside the text, reactions pinned to their version.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import EditHistoryModal from '@/components/chat/EditHistoryModal.vue';

const render = (over = {}) =>
	mount(EditHistoryModal, {
		props: {
			currentText: 'Встречаемся у второго узла в 19:30',
			currentSignHash: 'dms_tip',
			currentTime: '14:31',
			history: [
				{ signHash: 'dms_v2', text: 'Встречаемся у второго узла в 19:00', time: '14:22', verified: true, deletedFlag: false },
				{ signHash: 'dms_v1', text: 'Встречаемся у узла', time: '14:20', verified: true, deletedFlag: false },
			],
			reactionsByVersion: {},
			...over,
		},
	});

describe('edit history view', () => {
	it('counts every version and vouches for the signatures', () => {
		expect(render().find('.eh-sub').text()).toBe('3 versions · signature-verified');
	});

	// The board's own example: the time moved, and the moved word is what
	// lights up — no separate compare mode.
	it('highlights what the current edit changed inside the text', () => {
		const w = render();
		expect(w.find('.eh-version._current .eh-added').text()).toBe('19:30');
	});

	it('marks in a past version what the next edit removed', () => {
		const w = render();
		const past = w.findAll('.eh-version').filter((v) => !v.classes().includes('_current'));
		expect(past[0].find('.eh-removed').text()).toBe('19:00');
	});

	it('pins reactions to the exact version they were made on', () => {
		const w = render({ reactionsByVersion: { dms_v2: ['•', '•'] } });
		const past = w.findAll('.eh-version').filter((v) => !v.classes().includes('_current'));
		expect(past[0].find('.eh-reactions').text()).toContain('stays with this version');
		expect(past[1].find('.eh-reactions').exists()).toBe(false);
	});

	it('surfaces an unverifiable revision instead of dropping it', () => {
		const w = render({
			history: [{ signHash: 'dms_x', text: 'whatever', time: '', verified: false, deletedFlag: false }],
		});
		expect(w.find('.eh-unverified').text()).toBe('unverifiable revision');
	});

	it('keeps the version-scoped confirmation note in view', () => {
		expect(render().find('.eh-fine').text()).toMatch(/belong to a specific version/);
	});
});
