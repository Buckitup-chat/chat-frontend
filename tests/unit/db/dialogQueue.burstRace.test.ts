import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import type { ApiMutation } from '@/api/client';
import { clearDialogDatabases } from '../testHelpers';

interface MockIngestResult {
	index?: unknown;
	status?: string;
	error?: string;
}

vi.mock('@/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/api/client')>();
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: vi.fn(),
		},
	};
});

beforeEach(async () => {
	await clearDialogDatabases();
	vi.clearAllMocks();
});

async function freshQueue() {
	vi.resetModules();
	const q = await import('@/utils/db/tanstack/dialogQueue');
	await q.ensureRehydrated();
	return q;
}

const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(11)).secretKey;

function deferredIngestResponse() {
	let resolve!: (results: MockIngestResult[]) => void;
	const promise = new Promise<{ json: () => Promise<{ results: MockIngestResult[] }> }>((res) => {
		resolve = (results) => res({ json: async () => ({ results }) });
	});
	return { promise, resolve };
}

describe('flushPendingDialogChanges — burst-send race regression (Test A)', () => {
	it('a message enqueued while another message\'s request is in flight is not confirmed by that request\'s response, and is sent on the next flush', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		q.setSyncedRecorder(() => {});

		await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_A', content_b64: 'content-a' }, 'u_a');

		const { promise, resolve } = deferredIngestResponse();
		vi.mocked(api.ingestWithAuthEach).mockReturnValueOnce(promise as ReturnType<typeof api.ingestWithAuthEach>);

		const flushPromise = q.flushPendingDialogChanges(signSkey, 'u_a');

		await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_B', content_b64: 'content-b' }, 'u_a');
		expect(q.pendingDialogMessagesCollection.get('dmsg_B')).toBeTruthy();

		resolve([{ index: 0, status: 'ok' }]);
		await flushPromise;

		expect(q.pendingDialogMessagesCollection.get('dmsg_A')).toBeUndefined();
		expect(q.pendingDialogMessagesCollection.get('dmsg_B')).toBeTruthy();

		vi.mocked(api.ingestWithAuthEach).mockImplementationOnce(async (mutations: ApiMutation[]) => {
			expect(mutations).toHaveLength(1);
			return { json: async () => ({ results: mutations.map((_, i) => ({ index: i, status: 'ok' })) }) } as Awaited<ReturnType<typeof api.ingestWithAuthEach>>;
		});
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(q.pendingDialogMessagesCollection.get('dmsg_B')).toBeUndefined();

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — revision race regression (Test B)', () => {
	it('an edit that lands while the original revision\'s request is in flight is not wiped out by that request\'s "ok" response', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		const recorded: Array<{ key: string; record: { content_b64?: string | null } }> = [];
		q.setSyncedRecorder((_table, key, record) => {
			recorded.push({ key, record });
		});

		const revision1 = await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_X', content_b64: 'content-v1' }, 'u_a');
		expect(revision1.revision).toBe(1);

		const { promise, resolve } = deferredIngestResponse();
		vi.mocked(api.ingestWithAuthEach).mockReturnValueOnce(promise as ReturnType<typeof api.ingestWithAuthEach>);

		const flushPromise = q.flushPendingDialogChanges(signSkey, 'u_a');

		const revision2 = await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_X', content_b64: 'content-v2' }, 'u_a');
		expect(revision2.revision).toBe(2);

		resolve([{ index: 0, status: 'ok' }]);
		await flushPromise;

		expect(q.pendingDialogMessagesCollection.get('dmsg_X')).toMatchObject({ content_b64: 'content-v2' });
		expect(q.queueStatus.value.pending).toBeGreaterThanOrEqual(1);
		expect(recorded.some((r) => r.record.content_b64 === 'content-v2')).toBe(false);

		vi.mocked(api.ingestWithAuthEach).mockImplementationOnce(async (mutations: ApiMutation[]) => {
			expect(mutations).toHaveLength(1);
			return { json: async () => ({ results: mutations.map((_, i) => ({ index: i, status: 'ok' })) }) } as Awaited<ReturnType<typeof api.ingestWithAuthEach>>;
		});
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(q.pendingDialogMessagesCollection.get('dmsg_X')).toBeUndefined();
		expect(recorded.some((r) => r.record.content_b64 === 'content-v2')).toBe(true);

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — all-results-ok path correlation (Test E)', () => {
	it('when every result in the response is "ok", only the entries actually in that batch snapshot are confirmed', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		q.setSyncedRecorder(() => {});

		await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_A', content_b64: 'content-a' }, 'u_a');

		const { promise, resolve } = deferredIngestResponse();
		vi.mocked(api.ingestWithAuthEach).mockReturnValueOnce(promise as ReturnType<typeof api.ingestWithAuthEach>);

		const flushPromise = q.flushPendingDialogChanges(signSkey, 'u_a');

		await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_B', content_b64: 'content-b' }, 'u_a');

		resolve([{ index: 0, status: 'ok' }]);
		await flushPromise;

		expect(q.pendingDialogMessagesCollection.get('dmsg_A')).toBeUndefined();
		expect(q.pendingDialogMessagesCollection.get('dmsg_B')).toBeTruthy();

		q.setSyncedRecorder(null);
	});
});
