// Vue composable: reactive row list from a TanStack DB collection.
// Handles preload, change subscription, and teardown when the source
// collection changes (e.g. navigating between dialogs) or unmounts.
import { ref, watch, onBeforeUnmount, type Ref } from 'vue';

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

export function useCollectionRows<T>(collection: Ref<CollectionLike<T> | null | undefined>) {
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

	// A tab opened while the local node is unreachable must not stay empty
	// forever: retry the preload with exponential backoff while the component
	// is mounted, then keep probing at a low frequency. Note the browser's
	// `online` event is not a substitute — the browser can be "online" while
	// the specific BuckitUp node is not reachable.
	const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
	const IDLE_RETRY_MS = 30000;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const attach = async (coll: CollectionLike<T> | null | undefined) => {
		detach();
		const my = token;
		rows.value = [];
		ready.value = false;
		if (!coll) return;

		for (let attempt = 0; ; attempt++) {
			try {
				await coll.preload();
				break;
			} catch (e) {
				const delay = RETRY_DELAYS_MS[attempt] ?? IDLE_RETRY_MS;
				console.warn(`[data] shape preload failed (attempt ${attempt + 1}), retrying in ${delay / 1000}s:`, e);
				await sleep(delay);
				if (my !== token) return; // source changed / unmounted while waiting
			}
		}
		if (my !== token) return; // source changed while preloading

		rows.value = coll.toArray;
		ready.value = true;
		sub = coll.subscribeChanges(() => {
			rows.value = coll.toArray;
		});
	};

	watch(collection, (coll) => { attach(coll); }, { immediate: true });
	onBeforeUnmount(detach);

	return { rows, ready };
}
