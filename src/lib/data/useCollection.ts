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

	const attach = async (coll: CollectionLike<T> | null | undefined) => {
		detach();
		const my = token;
		rows.value = [];
		ready.value = false;
		if (!coll) return;

		try {
			await coll.preload();
		} catch (e) {
			console.error('[data] shape preload failed:', e);
			return;
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
