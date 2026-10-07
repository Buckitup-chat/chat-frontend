import { ref, computed, watch, onScopeDispose, type ComputedRef } from 'vue';
import { accountOutboxSnapshot, onOutboxChange } from '@/lib/data/outbox';
import { intentsOf, onIntentChange } from '@/lib/data/intents';
import { hasBlockedShapes, onBlockedChange } from '@/lib/data/accessGate';

export type AccountSyncState = 'offline' | 'syncing' | 'needs_attention' | 'synced';

export interface AccountQueueCounts {
	intents: number;
	unfinished: number;
	quarantined: number;
	discoveryBlocked?: number;
}

export const accountSyncState = (online: boolean, counts: AccountQueueCounts | null): AccountSyncState => {
	if (!online) return 'offline';
	if (!counts) return 'syncing';
	if (counts.quarantined > 0 || (counts.discoveryBlocked ?? 0) > 0) return 'needs_attention';
	return counts.intents > 0 || counts.unfinished > 0 ? 'syncing' : 'synced';
};

export function useAccountSyncStatus(
	userHash: () => string | null | undefined,
	online: () => boolean,
	readFallback: () => boolean = () => false
): ComputedRef<AccountSyncState> {
	const counts = ref<AccountQueueCounts | null>(null);
	let generation = 0;

	const refresh = async () => {
		const hash = userHash();
		const current = ++generation;
		if (!hash) {
			counts.value = { intents: 0, unfinished: 0, quarantined: 0 };
			return;
		}
		let next: AccountQueueCounts | null;
		try {
			const intents = (await intentsOf(hash)).entries.length;
			const { pending, quarantined, corrupt, blocked } = await accountOutboxSnapshot(hash);
			next = {
				intents,
				unfinished: pending.filter((e) => !e.reconciledAt).length,
				quarantined: quarantined.length + corrupt.length,
				discoveryBlocked: blocked.filter((issue) => issue.discovery).length,
			};
		} catch {
			next = null;
		}
		if (current === generation) counts.value = next;
	};

	watch(userHash, () => {
		counts.value = null;
		void refresh();
	}, { immediate: true });
	const onChange = (changedUserHash: string) => {
		if (changedUserHash === userHash()) void refresh();
	};
	onScopeDispose(onOutboxChange(onChange));
	onScopeDispose(onIntentChange(onChange));
	const accessBlocked = ref(hasBlockedShapes());
	onScopeDispose(onBlockedChange(() => { accessBlocked.value = hasBlockedShapes(); }));

	return computed(() => {
		const state = accountSyncState(online(), counts.value);
		return state === 'synced' && (readFallback() || accessBlocked.value) ? 'syncing' : state;
	});
}
