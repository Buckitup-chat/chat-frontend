// The Checkpoints screen's data: which dialogs hold a checkpoint this account
// signed on this device, whether each moved since, and — for those that did —
// what changed. Everything comes from the dialogs store: the pointer index
// (checkpointPeers), the alert per dialog (refreshCheckpointAlert, kept in
// checkpointAlerts), and the comparison the dialog itself shows
// (loadCheckpointComparison).
//
// Dialogs are checked one at a time, like the dialogs list's sweep: each
// check opens the dialog's shape, and a parallel run would put one long-poll
// per dialog on the wire at once. A dialog already checked this session
// (the dialogs list sweeps too) shows at once and is re-checked in place.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { loadCheckpointComparison } from '@/lib/data/checkpointComparison';
import { checkpointSummaryText, countCheckpointChanges, groupCheckpointDialogs } from '@/lib/data/checkpointSummary';

/** A dialog's check, like the store's sweep: one stuck shape must not hold up the rest. */
export const CHECK_BUDGET_MS = 15_000;
/** The comparison reads the whole dialog three times over; it gets longer. */
export const COMPARE_BUDGET_MS = 30_000;

const withBudget = (promise, ms) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('budget exceeded')), ms); }),
	]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} dialogs the dialogs store
 * @param {() => string[]} peers every peer the account knows (user cards)
 */
export function useCheckpointOverview(dialogs, peers) {
	let alive = true;
	onBeforeUnmount(() => { alive = false; });

	/** 'loading' until the pointer index is read; 'failed' when it could not be. */
	const index = ref('loading');
	/** Peers whose dialog holds a pointer, in the order they were found. */
	const candidates = ref([]);
	/** peer -> 'pending' | 'done' | 'none' (no checkpoint after all) | 'error' */
	const status = reactive(new Map());
	/** peer -> { messageId, state: 'loading' | 'ready' | 'failed', result } */
	const comparisons = reactive(new Map());

	const checkQueue = [];
	const compareQueue = [];
	let working = false;

	const queueComparison = (peerHash, first = false) => {
		const at = compareQueue.indexOf(peerHash);
		if (at >= 0) compareQueue.splice(at, 1);
		if (first) compareQueue.unshift(peerHash);
		else compareQueue.push(peerHash);
	};

	const check = async (peerHash) => {
		try {
			const alert = await withBudget(dialogs.refreshCheckpointAlert(peerHash), CHECK_BUDGET_MS);
			if (!alive) return;
			status.set(peerHash, alert ? 'done' : 'none');
			const known = comparisons.get(peerHash);
			if (alert?.changed && known?.messageId !== alert.messageId) queueComparison(peerHash);
		} catch (e) {
			console.warn('[checkpoints] the dialog could not be checked:', peerHash, e?.message || e);
			if (alive) status.set(peerHash, 'error');
		}
	};

	const compare = async (peerHash) => {
		const alert = dialogs.checkpointAlerts.get(peerHash);
		if (!alert?.changed || status.get(peerHash) === 'error') return;
		const { messageId } = alert;
		if (comparisons.get(peerHash)?.messageId === messageId && comparisons.get(peerHash)?.state !== 'failed') return;
		comparisons.set(peerHash, { messageId, state: 'loading', result: null });
		try {
			const result = await withBudget((async () => {
				const part = await dialogs.readCheckpointPart(peerHash, messageId);
				if (!part) throw new Error('the checkpoint message could not be read');
				return loadCheckpointComparison(dialogs, peerHash, part, messageId);
			})(), COMPARE_BUDGET_MS);
			if (alive) comparisons.set(peerHash, { messageId, state: 'ready', result });
		} catch (e) {
			console.warn('[checkpoints] the comparison could not be loaded:', peerHash, e?.message || e);
			if (alive) comparisons.set(peerHash, { messageId, state: 'failed', result: null });
		}
	};

	// One worker; the alert checks go first so the lists fill before the
	// details of what changed arrive.
	const work = async () => {
		if (working) return;
		working = true;
		try {
			while (alive && (checkQueue.length || compareQueue.length)) {
				if (checkQueue.length) await check(checkQueue.shift());
				else await compare(compareQueue.shift());
			}
		} finally {
			working = false;
		}
	};

	const enqueueChecks = (peerHashes) => {
		for (const peerHash of peerHashes) {
			if (checkQueue.includes(peerHash)) continue;
			status.set(peerHash, 'pending');
			checkQueue.push(peerHash);
		}
		void work();
	};

	// The peers arrive with the user cards and keep arriving; each new one
	// whose dialog is indexed is checked once.
	let indexRead = 0;
	const readIndex = async () => {
		const read = ++indexRead;
		const list = peers();
		let found;
		try {
			found = await dialogs.checkpointPeers(list);
		} catch (e) {
			console.warn('[checkpoints] the checkpoint index could not be read:', e?.message || e);
			found = null;
		}
		if (!alive || read !== indexRead) return;
		if (found === null) {
			if (!candidates.value.length) index.value = 'failed';
			return;
		}
		index.value = 'ready';
		const fresh = found.filter((p) => !candidates.value.includes(p));
		if (!fresh.length) return;
		candidates.value = [...candidates.value, ...fresh];
		enqueueChecks(fresh);
	};
	watch(() => peers().join(','), () => { void readIndex(); }, { immediate: true });

	/** Dialogs with a result to show: checked now or earlier this session. */
	const entries = computed(() => candidates.value.flatMap((peerHash) => {
		const s = status.get(peerHash);
		const alert = dialogs.checkpointAlerts.get(peerHash);
		if (!alert || s === 'none' || s === 'error') return [];
		return [{ peerHash, changed: !!alert.changed, createdAt: alert.createdAt, messageId: alert.messageId }];
	}));
	const groups = computed(() => groupCheckpointDialogs(entries.value));
	const pending = computed(() => candidates.value.filter((p) => status.get(p) === 'pending'));
	/** Pending dialogs with nothing to show yet: the skeleton rows. */
	const waiting = computed(() => pending.value.filter((p) => !dialogs.checkpointAlerts.get(p)));
	const failed = computed(() => candidates.value.filter((p) => status.get(p) === 'error'));

	/** The comparison for a changed dialog, if loaded: kind 'diff' or 'verdict'. */
	const comparisonOf = (peerHash) => {
		const alert = dialogs.checkpointAlerts.get(peerHash);
		const c = comparisons.get(peerHash);
		return c && alert && c.messageId === alert.messageId ? c : null;
	};

	/** "2 edits, 1 deleted · 3 new after" once the comparison is in; '' before. */
	const summaryOf = (peerHash) => {
		const c = comparisonOf(peerHash);
		if (c?.state !== 'ready' || c.result.kind !== 'diff') return '';
		return checkpointSummaryText(countCheckpointChanges(c.result.changes, c.result.futureAdded));
	};

	/** Moves a dialog's comparison to the front: the user is looking at it. */
	const wantComparison = (peerHash) => {
		const c = comparisonOf(peerHash);
		if (c && c.state !== 'failed') return;
		queueComparison(peerHash, true);
		void work();
	};

	const retry = () => {
		if (index.value === 'failed') {
			index.value = 'loading';
			void readIndex();
		}
		enqueueChecks(failed.value);
	};

	return { index, groups, pending, waiting, failed, comparisonOf, summaryOf, wantComparison, retry };
}
