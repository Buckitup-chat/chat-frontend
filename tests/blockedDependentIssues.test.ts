import { describe, it, expect, beforeEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import {
	enqueue, recordFailure, discardEntry, blockedDependentIssues,
	_setStorageForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const editMessage = (messageId: string, userHash = MY_HASH) => ([{
	type: 'update',
	modified: {
		message_id: messageId, sender_hash: userHash, dialog_hash: 'dh1',
		content_b64: 'x', parent_sign_hash: null, owner_timestamp: 1,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('blockedDependentIssues: UI-safe blocked-reason read layer', () => {
	it('1. B depends on a quarantined A: returns B with blocker A status quarantined and its reason', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected by peer', { permanent: true }));
		const bDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: bDeps });

		const issues = await blockedDependentIssues(MY_HASH);

		expect(issues).toHaveLength(1);
		expect(issues[0].entry).toEqual({ id: bId, relation: 'dialog_messages' });
		expect(issues[0].blockers).toEqual([
			{ id: aId, relation: 'dialog_messages', status: 'quarantined', lastError: 'rejected by peer' },
		]);
	});

	it('2. B depends on a discarded A: returns B with a terminal blocker A status discarded', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: bDeps });

		await discardEntry(aId as string);

		const issues = await blockedDependentIssues(MY_HASH);

		expect(issues).toHaveLength(1);
		expect(issues[0].entry.id).toBe(bId);
		expect(issues[0].blockers).toEqual([
			{ id: aId, relation: 'dialog_messages', status: 'discarded', lastError: 'rejected' },
		]);
	});

	it('3. B depends only on a still-pending A: not a problem — excluded from the list', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: [aId as string] });

		const issues = await blockedDependentIssues(MY_HASH);

		expect(issues.some((i) => i.entry.id === bId)).toBe(false);
	});

	it('4. B depends on an id that was never durably written: unresolvable, blocked, and shown as status "unknown"', async () => {
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: ['never-existed'] });

		const issues = await blockedDependentIssues(MY_HASH);

		const issue = issues.find((i) => i.entry.id === bId);
		expect(issue).toBeTruthy();
		expect(issue!.blockers).toEqual([
			{ id: 'never-existed', relation: 'unknown', status: 'unknown', lastError: null },
		]);
	});

	it('5. B depends on a pending P and a discarded A: shown via A only, P is not reported as a permanent reason', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await discardEntry(aId as string);
		const pId = await enqueue(editMessage('msg_P'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: [aId as string, pId as string] });

		const issues = await blockedDependentIssues(MY_HASH);

		const issue = issues.find((i) => i.entry.id === bId);
		expect(issue).toBeDefined();
		expect(issue!.blockers).toEqual([{ id: aId, relation: 'dialog_messages', status: 'discarded', lastError: 'rejected' }]);
		expect(issue!.blockers.some((b) => b.id === pId)).toBe(false);
	});

	it('6. account isolation: another account\'s blocked dependents never appear', async () => {
		const aId = await enqueue(editMessage('msg_X', MY_HASH), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bId = await enqueue(editMessage('msg_X', MY_HASH), MY_HASH, { dependsOn: [aId as string] });

		const otherAId = await enqueue(editMessage('msg_Y', OTHER_HASH), OTHER_HASH);
		await recordFailure(otherAId, new IngestError('rejected', { permanent: true }));
		await enqueue(editMessage('msg_Y', OTHER_HASH), OTHER_HASH, { dependsOn: [otherAId as string] });

		const mine = await blockedDependentIssues(MY_HASH);
		expect(mine.map((i) => i.entry.id)).toEqual([bId]);

		const theirs = await blockedDependentIssues(OTHER_HASH);
		expect(theirs.every((i) => i.entry.id !== bId)).toBe(true);
	});

	it('7. ordering is stable across repeated calls', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: [aId as string] });
		const cId = await enqueue(editMessage('msg_Y'), MY_HASH);
		await recordFailure(cId, new IngestError('rejected', { permanent: true }));
		await enqueue(editMessage('msg_Y'), MY_HASH, { dependsOn: [cId as string] });

		const first = await blockedDependentIssues(MY_HASH);
		const second = await blockedDependentIssues(MY_HASH);

		expect(second.map((i) => i.entry.id)).toEqual(first.map((i) => i.entry.id));
		expect(second.map((i) => i.blockers.map((b) => b.id))).toEqual(first.map((i) => i.blockers.map((b) => b.id)));
	});

	it('8. survives a reload (fresh storage handle over the same data) with the same blocked reason', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		await discardEntry(aId as string);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: [aId as string] });

		_setStorageForTests({ ...backing }); // reload: a new object over the same bytes

		const issues = await blockedDependentIssues(MY_HASH);
		expect(issues.find((i) => i.entry.id === bId)?.blockers).toEqual([
			{ id: aId, relation: 'dialog_messages', status: 'discarded', lastError: 'rejected' },
		]);
	});

	it('9. is read-only: does not requeue, discard, or otherwise change any entry', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: [aId as string] });
		const before = new Map(backing.map);

		await blockedDependentIssues(MY_HASH);

		expect(backing.map).toEqual(before);
		expect(backing.map.has(aId as string)).toBe(true);
		expect(backing.map.has(bId as string)).toBe(true);
	});
});
