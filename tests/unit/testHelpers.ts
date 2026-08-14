import type { ResolvedPendingRecord, UserRecordFields } from '@/utils/db/tanstack/userQueue';
import type { ApiMutation } from '@/api/client';
import { MutationType } from '@/api/client';

export function assertReady(resolved: ResolvedPendingRecord): { ready: true; record: UserRecordFields; mutationType: MutationType } {
	if (!resolved.ready) throw new Error('expected resolvePendingRecord(...) to be ready');
	return resolved;
}

export function modifiedOf(mutation: ApiMutation): Record<string, unknown> {
	if (!mutation.modified) throw new Error('expected mutation.modified to be set (insert)');
	return mutation.modified;
}

export function changesOf(mutation: ApiMutation): Record<string, unknown> {
	if (!mutation.changes) throw new Error('expected mutation.changes to be set (update)');
	return mutation.changes;
}
