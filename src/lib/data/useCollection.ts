// Vue composable: reactive row list from a TanStack DB collection.
// Handles preload, change subscription, and teardown when the source
// collection changes (e.g. navigating between dialogs) or unmounts.
import { ref, watch, onBeforeUnmount, type Ref } from 'vue';

interface CollectionLike<T> {
	preload: () => Promise<unknown>;
	subscribeChanges: (cb: () => void) => () => void;
	readonly toArray: T[];
}

export function useCollectionRows<T>(collection: Ref<CollectionLike<T> | null | undefined>) {
	const rows = ref<T[]>([]) as Ref<T[]>;
	const ready = ref(false);
	let unsub: (() => void) | null = null;
	let token = 0;

	const detach = () => {
		token++;
		if (unsub) {
			unsub();
			unsub = null;
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
		unsub = coll.subscribeChanges(() => {
			rows.value = coll.toArray;
		});
	};

	watch(collection, (coll) => { attach(coll); }, { immediate: true });
	onBeforeUnmount(detach);

	return { rows, ready };
}
