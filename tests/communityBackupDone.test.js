// @vitest-environment jsdom
// The summary of a finished backup (design 9.1): each guardian by what they
// said about their piece, the health line counting only stored pieces, and a
// prompt to reshare under a piece that no longer counts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { effectScope } from 'vue';
import { candidate, fakeBackupStore, fakeNav, hash, makeRun } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null, user: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));

const { DRAFT, NAV, createBackupDraft } = await import('@/components/recovery/backup/backupFlow');
const { default: Screen_Done } = await import('@/components/recovery/backup/Screen_Done.vue');

let scope;
const render = () => {
	scope = effectScope();
	const draft = scope.run(() => createBackupDraft(H.store));
	return mount(Screen_Done, { global: { provide: { [DRAFT]: draft, [NAV]: fakeNav() } } });
};

beforeEach(() => {
	H.store = fakeBackupStore({ candidates: [candidate('Daria', 'agreed', 'a'), candidate('Milo', 'agreed', 'b'), candidate('Vitalii', 'agreed', 'c')] });
	H.user = { contactsMap: {}, currentUserHash: hash('o') };
	const run = makeRun({ step: 'done', secretId: '0x1', version: 1 });
	run.sent = Object.fromEntries(run.guardians.map((g, i) => [g.userHash, { messageId: `m${i}`, shareIndex: i + 1 }]));
	H.store.run = run;
});
afterEach(() => scope?.stop());

describe('the summary with the guardians’ receipts', () => {
	it('counts the stored pieces and prompts a reshare under a piece given back or with a problem', () => {
		H.store.receipts = { [hash('a')]: 'stored', [hash('b')]: 'given_back', [hash('c')]: 'problem' };
		H.store.receiptDetails = { [hash('c')]: { state: 'problem', detail: 'the share does not match its leaf' } };
		const w = render();
		expect(w.find('.health-count').text()).toBe('1 of 3');
		const rows = w.findAll('[data-test="roster-row"]');
		expect(rows.map((r) => r.text())).toEqual([
			expect.stringMatching(/Daria.*holds a piece/),
			expect.stringMatching(/Milo.*They gave it back\. A reshare replaces this piece\..*gave it back/),
			expect.stringMatching(/Vitalii.*They report: the share does not match its leaf\. A reshare replaces this piece\..*has a problem/),
		]);
		expect(rows[0].find('[data-test="roster-hint"]').exists()).toBe(false);
	});

	it('without receipts shows every piece sent and none held', () => {
		const w = render();
		expect(w.find('.health-count').text()).toBe('0 of 3');
		expect(w.findAll('[data-test="roster-row"]').map((r) => r.text())).toEqual([
			expect.stringMatching(/Daria.*sent/), expect.stringMatching(/Milo.*sent/), expect.stringMatching(/Vitalii.*sent/),
		]);
	});
});
