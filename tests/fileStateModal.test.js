// @vitest-environment jsdom
// Screen 05: big chunks, honest wording, one button, the backfill journal.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import FileStateModal from '@/components/chat/FileStateModal.vue';
import { recordAvailability, backfillLog } from '@/lib/data/availabilityLog';

const part = {
	kind: 'file', name: 'mesh-dump.tar', size: 64_700_000, mimeType: 'application/x-tar',
	createdAt: 0, fileId: 'f_' + 'a'.repeat(32), encSecretB64: 'x',
};

const render = (over = {}) =>
	mount(FileStateModal, {
		props: {
			part,
			availability: { present: 5, total: 12, unknown: false, deleted: false },
			log: [], from: 'Ирина', sentAt: '14:12',
			...over,
		},
	});

describe('file state screen', () => {
	it('draws the chunks big with the header line', () => {
		const w = render();
		expect(w.findAll('.fs-chunk')).toHaveLength(12);
		expect(w.findAll('.fs-chunk._have')).toHaveLength(5);
		expect(w.find('.fs-meta').text()).toBe('61.7 MB · from Ирина · 14:12');
		expect(w.find('.fs-percent').text()).toBe('42%');
	});

	// Partial availability is a process, not a breakdown — the single button
	// asks for backfill; once everything is here, the same button downloads.
	it('offers backfill while partial and download when complete', async () => {
		expect(render().find('.fs-btn').text()).toBe('Request priority backfill');
		const done = render({ availability: { present: 12, total: 12, unknown: false, deleted: false } });
		expect(done.find('.fs-btn').text()).toBe('Download');
		await done.find('.fs-btn').trigger('click');
		expect(done.emitted('refresh')).toBeTruthy();
	});

	it('claims nothing while the manifest is unknown', () => {
		const w = render({ availability: { present: 0, total: 0, unknown: true, deleted: false } });
		expect(w.find('.fs-chunks').exists()).toBe(false);
		expect(w.text()).toContain('manifest has not reached this node');
	});

	it('narrates the backfill journal in order', () => {
		const w = render({
			log: [
				{ at: 1788500000, present: 0, total: 12 },
				{ at: 1788501140, present: 2, total: 12 },
				{ at: 1788506520, present: 5, total: 12 },
			],
		});
		const rows = w.findAll('.fs-log-row').map((r) => r.find('.fs-log-text').text());
		expect(rows[0]).toBe('Metadata arrived, no chunks yet');
		expect(rows[1]).toBe('2 of 12 chunks — backfill continuing');
		expect(rows[2]).toBe('5 of 12 chunks — backfill continuing');
	});

	it('keeps the 48-hour retention note in view', () => {
		expect(render().find('.fs-fine').text()).toMatch(/48 hours/);
	});
});

describe('availability journal', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('records growth and ignores repeat polls', () => {
		const id = 'f_' + String(Math.random()).slice(2).padEnd(32, '0').slice(0, 32);
		recordAvailability(id, 0, 12);
		recordAvailability(id, 0, 12); // same count — noise, not an event
		recordAvailability(id, 2, 12);
		recordAvailability(id, 5, 12);
		expect(backfillLog(id).map((e) => e.present)).toEqual([0, 2, 5]);
	});
});
