<template>
	<ScreenHeader :title="title" />

	<template v-if="run">
		<div v-if="interrupted" class="cb-muted" data-test="interrupted">Last progress {{ agoText(run.updatedAt) }}. {{ existsText }}</div>

		<div class="d-flex flex-column">
			<template v-if="collapsed">
				<div class="pg-step">
					<span class="pg-dot done"><Check :size="12" /></span>
					<span class="pg-label done">Steps 1–3 done</span>
				</div>
			</template>
			<template v-for="s in shownSteps" :key="s.n">
				<div v-if="s.n === 3 && !collapsed" class="cb-divider py-1">from here the backup exists</div>
				<div class="pg-step" :data-test="`step-${s.n}`">
					<span class="pg-dot" :class="s.state">
						<Check v-if="s.state === 'done'" :size="12" />
						<span v-else-if="s.state === 'warn'">!</span>
						<span v-else-if="s.state === 'active' && store.running" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
					</span>
					<div class="d-flex flex-column gap-1 flex-grow-1">
						<span class="pg-label" :class="s.state">{{ s.label }}</span>
						<span v-if="s.note" class="cb-small">{{ s.note }}</span>
					</div>
				</div>

				<!-- 4: one row per node -->
				<template v-if="s.n === 4 && current >= 4">
					<div class="cb-group pg-rows">
						<div v-for="r in nodeRows" :key="r.id" class="d-flex align-items-center gap-2 py-2" data-test="node-outcome">
							<span class="flex-grow-1 small fw-medium">{{ r.name }}</span>
							<span :class="r.cls">{{ r.text }}</span>
						</div>
					</div>
					<div v-if="nodesFailed && store.runsHere" class="cb-warn pg-rows" data-test="nodes-failed">
						<span>{{ nodesFailedText }}</span>
						<div class="d-flex gap-2">
							<button class="btn btn-sm btn-outline-dark bg-white flex-fill" :disabled="store.running" data-test="keep-retrying" @click="retry">Keep retrying</button>
							<button v-if="canFinish" class="btn btn-sm btn-dark flex-fill" :disabled="store.running" data-test="finish-without" @click="finishWithout">Finish without it</button>
						</div>
					</div>
				</template>

				<!-- 5: one row per guardian: sent → delivered → stored -->
				<template v-if="s.n === 5 && current >= 4">
					<div class="cb-group pg-rows">
						<div v-for="r in guardianRows" :key="r.userHash" class="d-flex align-items-center gap-2 py-2" data-test="guardian-outcome">
							<span class="flex-grow-1 small fw-medium">{{ r.name }}</span>
							<span class="d-flex gap-1">
								<span v-for="i in 3" :key="i" class="pg-tick" :class="{ on: i <= r.ticks }"></span>
							</span>
							<span class="pg-state" :class="{ stored: r.state === 'stored' }">{{ DELIVERY_WORDS[r.state] }}</span>
						</div>
					</div>
				</template>
			</template>
		</div>

		<div v-if="stopNote" class="cb-warn" data-test="stopped">
			<span>{{ stopNote }}</span>
			<div v-if="store.runsHere"><button class="btn btn-sm btn-dark" :disabled="store.running" data-test="retry" @click="retry">Retry</button></div>
		</div>
		<div v-if="actionError" class="cb-error">{{ actionError }}</div>

		<div v-if="!store.runsHere" class="cb-block" data-test="other-device">
			<span class="fw-semibold">{{ store.heldElsewhere ? 'Running in another tab' : `Running on your ${run.device}` }}</span>
			<template v-if="store.canTakeOver">
				<span class="cb-muted">No progress for {{ agoText(run.updatedAt).replace(/ ago$/, '') }}. If that device is lost or closed, continue here.</span>
				<div><button class="btn btn-sm btn-dark" data-test="take-over" @click="takeOver">Continue on this device</button></div>
			</template>
			<span v-else class="cb-muted">This device shows its progress and does not start a second backup.</span>
		</div>

		<div v-if="run.step !== 'done'" class="cb-small text-center">You can close the app. The backup continues from this step next time.</div>

		<div v-if="store.runsHere" class="cb-actions">
			<button v-if="interrupted" class="btn btn-dark w-100" data-test="continue" @click="retry">Continue</button>
			<button v-if="discardable" class="btn btn-outline-dark w-100" :disabled="store.running || busy" data-test="cancel" @click="cancel">Cancel</button>
		</div>
	</template>
	<div v-else class="cb-muted">There is no backup being created.</div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { canDiscard, canFinishWithoutPending, nodeHolds, nodesDone, nodesPending, stepNumber } from '@/lib/recovery/backupRun';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import Check from './Check.vue';
import { DELIVERY_WORDS, DRAFT, NAV, STEP_LABELS, agoText, guardianDelivery, guardianName, nodeRefName } from './backupFlow';
// sent → delivered → stored; a piece that no longer counts shows how far it got before.
const TICKS = { waiting: 0, sent: 1, delivered: 2, stored: 3, problem: 2, given_back: 2, dropped: 2 };

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const run = computed(() => store.current);
const current = computed(() => (run.value ? stepNumber(run.value) : 1));
const isDone = computed(() => run.value?.step === 'done');

const nodesFailed = computed(() => {
	const r = run.value;
	if (!r || store.running || r.step !== 'registered') return false;
	return store.stopped === 'nodes_failed' || nodesPending(r).some((n) => r.nodeOutcomes[n.id]?.state === 'failed');
});
const canFinish = computed(() => nodesFailed.value && canFinishWithoutPending(run.value));
const regPending = computed(() => !store.running && store.stopped === 'registration_pending');
const otherError = computed(() => (!store.running && store.stopped && !['nodes_failed', 'registration_pending'].includes(store.stopped) ? store.stopped : null));
/** Opened on a run nobody is driving, with nothing to report: it simply stopped. */
const interrupted = computed(() => !!run.value && !isDone.value && !store.running && store.runsHere && !nodesFailed.value && !regPending.value && !otherError.value);
const discardable = computed(() => !!run.value && canDiscard(run.value));

const changing = computed(() => !!run.value?.reshareOf);
const title = computed(() => {
	if (interrupted.value) return changing.value ? 'The change to your backup was not finished' : 'Your backup was not finished';
	if (isDone.value) return 'Backup created';
	return changing.value ? 'Changing your backup' : 'Creating your backup';
});
const existsText = computed(() =>
	current.value >= 3 ? 'The backup already exists on the network, so nothing has to start over.' : 'Nothing is on the network yet: you can continue, or cancel it.',
);
const stopNote = computed(() => {
	if (regPending.value) return 'The network has not confirmed the registration yet. It may still arrive: retrying checks again and does not register twice.';
	if (otherError.value) return `Stopped: ${otherError.value}`;
	return null;
});

// From step 4 the first three fold into one line, as in the design.
const collapsed = computed(() => current.value >= 4);
const shownSteps = computed(() =>
	STEP_LABELS.map((label, i) => {
		const n = i + 1;
		let state = 'todo';
		if (isDone.value || n < current.value) state = 'done';
		else if (n === current.value) state = store.running || interrupted.value ? 'active' : 'warn';
		let note = null;
		if (n === 3 && state === 'active' && store.running) note = 'Waiting for confirmation… this can take a few minutes.';
		if (n === 4 && current.value >= 4) note = `${nodesDone(run.value)} of ${run.value.nodes.length} nodes have their part`;
		// Step 4 can stand while guardians are already being sent theirs.
		if (n === 5 && current.value === 4) state = run.value.guardians.every((g) => run.value.sent[g.userHash]) ? 'done' : store.running ? 'active' : 'todo';
		return { n, label, state, note };
	}).filter((s) => !collapsed.value || s.n >= 4),
);

const nodeName = (ref) => nodeRefName(ref, store.nodes, $userPQ);
const nodeRows = computed(() =>
	(run.value?.nodes ?? []).map((n) => {
		const outcome = run.value.nodeOutcomes[n.id];
		let text = store.running ? 'sending…' : 'waiting';
		let cls = 'cb-status-off';
		if (run.value.skippedNodes.includes(n.id)) text = 'left out';
		else if (nodeHolds(run.value, n.id)) [text, cls] = ['✓', 'cb-status-ok'];
		else if (outcome?.state === 'failed') [text, cls] = [store.running ? 'offline · retrying' : 'did not take its part', 'cb-status-warn'];
		return { id: n.id, name: nodeName(n), text, cls };
	}),
);
const pendingNames = computed(() => (run.value ? nodesPending(run.value).map(nodeName) : []));
const nodesFailedText = computed(() => {
	const r = run.value;
	const head = `${nodesDone(r)} of ${r.nodes.length} nodes have their part. ${r.settings.nodeThreshold} are needed`;
	if (!canFinish.value) return `${head}, so the backup waits for more.`;
	const names = pendingNames.value.join(', ');
	return `${head}, so you can finish without ${names}'s node${pendingNames.value.length > 1 ? 's' : ''}.`;
});

const guardianRows = computed(() =>
	(run.value?.guardians ?? []).map((g) => {
		const state = guardianDelivery(run.value, g.userHash, store.receipts);
		return { userHash: g.userHash, name: guardianName(g.userHash, store.candidates, $userPQ), state, ticks: TICKS[state] };
	}),
);

// --- Actions ---------------------------------------------------------------

const busy = ref(false);
const actionError = ref(null);
const act = async (fn) => {
	actionError.value = null;
	try {
		await fn();
	} catch (e) {
		actionError.value = errorMessage(e);
	}
};
const retry = () => act(() => store.resume());
const takeOver = () => act(() => store.takeOver());
const finishWithout = () => act(() => store.finishWithoutPendingNodes());
const cancel = async () => {
	busy.value = true;
	await act(async () => {
		await store.discard();
		nav.close();
	});
	busy.value = false;
};

// Done: the summary takes over.
watch(
	isDone,
	(done) => {
		if (done) {
			draft.state.justFinished = true;
			nav.replace('done');
		}
	},
	{ immediate: true },
);

// Another device or tab may drive the run: follow it from the account's record.
onMounted(() => store.follow());
onBeforeUnmount(() => store.unfollow());
</script>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

.pg-step {
	display: flex;
	gap: 12px;
	padding: 8px 0;
}
.pg-dot {
	width: 22px;
	height: 22px;
	flex-shrink: 0;
	border-radius: 50%;
	border: 2px solid $light_grey2;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: #fff;
	font-weight: 700;
	font-size: 13px;
	&.done {
		border: 0;
		background: $green;
	}
	&.warn {
		border: 0;
		background: $warning;
	}
	&.active {
		border-color: $primary;
		color: $primary;
	}
	.spinner-border-sm {
		width: 14px;
		height: 14px;
		border-width: 2px;
	}
}
.pg-label {
	font-weight: 500;
	line-height: 22px;
	color: $grey_dark;
	&.done {
		color: #6c757d;
	}
	&.active,
	&.warn {
		font-weight: 600;
		color: #000;
	}
}
.pg-rows {
	margin-left: 34px;
	margin-bottom: 8px;
}
.pg-tick {
	width: 16px;
	height: 5px;
	border-radius: 3px;
	background: $light_grey2;
	&.on {
		background: $primary;
	}
}
.pg-state {
	width: 62px;
	text-align: right;
	font-size: 12px;
	font-weight: 500;
	&.stored {
		color: $primary;
		font-weight: 600;
	}
}
</style>
