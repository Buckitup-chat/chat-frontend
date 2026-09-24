// Vue composable: reactive row list from a TanStack DB collection.
// Handles preload, change subscription, and teardown when the source
// collection changes (e.g. navigating between dialogs) or unmounts.
import { ref, watch, onScopeDispose, type Ref } from 'vue';
import { preloadWithRetry } from './attach';
import { mergeLiveWithCached } from './readCache';
import { readDialogRows, type DialogCacheTable } from './dialogCache';
import { shapeLinkOf, whenLive } from './shapeLink';

// subscribeChanges returns a CollectionSubscription object, not an unsubscribe
// function — calling the return value throws and takes the component's
// beforeUnmount hook down with it.
interface Subscription {
	unsubscribe: () => void;
}

interface CollectionLike<T> {
	preload: () => Promise<unknown>;
	subscribeChanges: (cb: () => void) => Subscription;
	readonly toArray: T[];
}

export interface ReadCacheFallbackOptions<T> {
	table: string;
	dialogHash: () => string;
	getRowKey: (row: T) => string;
}

export function useCollectionRows<T extends Record<string, unknown>>(
	collection: Ref<CollectionLike<T> | null | undefined>,
	opts: { readCache?: ReadCacheFallbackOptions<T> } = {}
) {
	const rows = ref<T[]>([]) as Ref<T[]>;
	const ready = ref(false);
	let sub: Subscription | null = null;
	let token = 0;

	const detach = () => {
		token++;
		if (sub) {
			try {
				sub.unsubscribe();
			} catch (e) {
				console.warn('[data] unsubscribe failed:', e);
			}
			sub = null;
		}
	};

	const attach = async (coll: CollectionLike<T> | null | undefined) => {
		detach();
		const my = token;
		rows.value = [];
		ready.value = false;
		if (!coll) return;

		const readCache = opts.readCache;
		// Until the live set is confirmed, what the chat shows is the live
		// rows merged with the disk copy (live wins per key, touched rows stay
		// gone — mergeLiveWithCached). Once confirmed, the canonical live set
		// alone: including which rows are absent, so nothing from disk lingers.
		let liveSettled = false;
		let cached: T[] = [];
		const show = () => {
			if (my !== token) return;
			rows.value = liveSettled || !readCache
				? coll.toArray
				: mergeLiveWithCached(readCache.table, coll.toArray, cached, readCache.getRowKey);
		};

		if (readCache) {
			const scopeDialogHash = readCache.dialogHash();
			sub = coll.subscribeChanges(show);
			cached = (await readDialogRows(readCache.table as DialogCacheTable, scopeDialogHash)) as T[];
			if (my !== token) return;
			if (!liveSettled) {
				show();
				ready.value = true;
			}
		}

		if (shapeLinkOf(coll)) {
			void preloadWithRetry(coll, () => my !== token || liveSettled, 'dialog');
			await whenLive(coll as unknown as object);
		} else {
			// Shared reconnect policy (see attach.ts); stops when the source
			// changes or the component unmounts.
			const attached = await preloadWithRetry(coll, () => my !== token, 'dialog');
			if (!attached) return;
		}
		if (my !== token) return;

		liveSettled = true;
		cached = [];
		show();
		ready.value = true;
		if (!sub) sub = coll.subscribeChanges(show);
	};

	watch(collection, (coll) => { attach(coll); }, { immediate: true });
	onScopeDispose(detach);

	return { rows, ready };
}
