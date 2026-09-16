// Shared reconnect policy for Electric collections.
//
// A collection opened while the local node is unreachable must attach by
// itself once it comes back — otherwise the view stays empty until the user
// reloads. Note the browser's `online` event is not a usable signal here: the
// browser can be online while this particular BuckitUp node is not reachable.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const IDLE_RETRY_MS = 30000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PreloadableCollection {
	preload: () => Promise<unknown>;
}

/**
 * Preload with exponential backoff, then keep probing at a low frequency.
 * `isCancelled` is checked around every wait so a caller that navigated away
 * or unmounted stops the loop; it resolves false when cancelled.
 */
export async function preloadWithRetry(
	coll: PreloadableCollection,
	isCancelled: () => boolean = () => false,
	label = 'shape'
): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		if (isCancelled()) return false;
		try {
			await coll.preload();
			return !isCancelled();
		} catch (e) {
			const delay = RETRY_DELAYS_MS[attempt] ?? IDLE_RETRY_MS;
			console.warn(`[data] ${label} preload failed (attempt ${attempt + 1}), retrying in ${delay / 1000}s:`, e);
			await sleep(delay);
		}
	}
}
