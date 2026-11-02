<template>
	<section class="ui-card cb-card" data-test="community-backup-card">
		<div class="cb-head">
			<i class="_icon_guardians"></i>
			<h2 class="cb-title">Guardians</h2>
			<button v-if="state === 'done' && !run.revokedAt && !active" type="button" class="ui-btn _text _sm" data-test="manage"
				@click="open('manage')">Manage</button>
		</div>

		<!-- No network to back up on in this build -->
		<template v-if="state === 'unavailable'">
			<p class="cb-about">{{ ABOUT }}</p>
			<div class="ui-small ui-muted">Not available in this version of the app.</div>
		</template>

		<template v-else-if="state === 'loading'">
			<div v-if="loadError" class="ui-small ui-secondary">
				Could not read your backup: {{ loadError }}
				<button type="button" class="ui-btn _text _sm" @click="load">Try again</button>
			</div>
			<template v-else>
				<div class="ui-skeleton cb-skel-line"></div>
				<div class="ui-skeleton cb-skel-bar"></div>
				<div class="ui-caption ui-muted">Asking guardians…</div>
			</template>
		</template>

		<!-- 1.2: a run that has not finished — the first backup, or the change of a finished one above its health -->
		<template v-else-if="state === 'unfinished' || state === 'done'">
			<template v-if="active">
				<div class="ui-notice _warning cb-notice" data-test="unfinished">
					<div class="cb-notice-title">{{ unfinishedTitle }}</div>
					<div>{{ unfinishedText }}</div>
				</div>
				<div class="cb-actions">
					<button v-if="showDiscard" type="button" class="ui-btn _outline" :disabled="busy" data-test="discard" @click="discard">Discard</button>
					<button v-if="store.canTakeOver" type="button" class="ui-btn _outline" :disabled="busy" data-test="continue" @click="cont">Show progress</button>
					<button v-if="store.canTakeOver" type="button" class="ui-btn" :disabled="busy" data-test="take-over" @click="takeOver">Continue on this device</button>
					<button v-else type="button" class="ui-btn" :disabled="busy" data-test="continue" @click="cont">{{ continueLabel }}</button>
				</div>
				<div v-if="actionError" class="ui-caption cb-error-text">{{ actionError }}</div>
			</template>

			<!-- Revoked for good: nothing protects the account any more, and a new backup can take its place -->
			<template v-if="state === 'done' && run.revokedAt">
				<div class="ui-small ui-secondary" data-test="revoked">This backup was revoked for good. No recovery can use it.</div>
				<div class="cb-actions">
					<button type="button" class="ui-btn _outline" @click="open('manage')">Manage</button>
					<button type="button" class="ui-btn" :disabled="!!createBlocked" data-test="create-new" @click="open('guardians')">Create a new backup</button>
				</div>
				<div v-if="createBlocked" class="ui-caption ui-muted" data-test="create-reason">{{ createBlocked }}</div>
			</template>

			<!-- 1.0 / 1.3: the backup exists -->
			<template v-else-if="state === 'done'">
				<HealthLine :view="roster.health" :extra="healthExtra" />
				<ul v-if="!active" class="cb-roster">
					<li v-for="g in roster.rows" :key="g.userHash">
						<ContactAvatar :hash="g.userHash" small />
						<span class="cb-roster-name">{{ g.name }}</span>
						<span class="ui-caption" :class="`cb-state-${rosterTone(g)}`">{{ g.text }}</span>
					</li>
				</ul>
				<div v-if="roster.prompt && !active" class="ui-notice _warning cb-notice" data-test="reshare-prompt">
					<span>{{ roster.prompt.text }}</span>
					<div><button type="button" class="ui-btn _sm" data-test="reshare-cta" @click="open('reshare')">{{ roster.prompt.action }}</button></div>
				</div>
				<!-- The alerts bot is what lets the owner stop a recovery started from the guardians' pieces. -->
				<div v-if="!outsideAlerts" class="ui-notice _warning cb-notice" data-test="no-alerts">
					<span>No alerts. You may not learn about an attempt in time to stop it.</span>
					<span>{{ BOT_LINE }}</span>
					<div v-if="!active"><button type="button" class="ui-btn _sm" @click="open('alerts')">Set up alerts</button></div>
				</div>
			</template>
		</template>

		<!-- 1.1: no backup yet -->
		<template v-else>
			<p class="cb-about">{{ ABOUT }}</p>
			<div class="cb-agreed">
				<div class="cb-card-faces">
					<ContactAvatar v-for="c in agreed.slice(0, 3)" :key="c.userHash" :hash="c.userHash" small />
					<span v-for="i in Math.max(0, 2 - agreed.length)" :key="`p${i}`" class="cb-card-slot"></span>
				</div>
				<span class="ui-small" data-test="agreed">{{ agreedText }}</span>
			</div>
			<div class="cb-actions">
				<button type="button" class="ui-btn _outline" @click="open('guardians')">Ask guardians</button>
				<button type="button" class="ui-btn" :disabled="!!createBlocked" data-test="create" @click="open('guardians')">Create backup</button>
			</div>
			<div v-if="createBlocked" class="ui-caption ui-muted" data-test="create-reason">{{ createBlocked }}</div>
			<div class="ui-caption ui-muted">{{ BOT_LINE }}</div>
		</template>
	</section>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { canDiscard, stepNumber, unfinished } from '@/lib/recovery/backupRun';
import HealthLine from './HealthLine.vue';
import ContactAvatar from './ContactAvatar.vue';
import errorMessage from '@/utils/errorMessage';
import { ALERTS_BOT } from '@/config/recovery';
import { plural } from '@/lib/recovery/backupPlan';
import { STEP_LABELS, agoText, alertsText, guardianName, hasOutsideAlerts, rosterView, sparesLeft } from './backupFlow';

// The alerts bot, named where the owner decides about the backup: it is how
// they learn of a recovery started from the guardians' pieces in time to stop it.
const BOT_LINE = `@${ALERTS_BOT} on Telegram tells you when someone starts recovering your account from your guardians' pieces, so you can stop it.`;
const ABOUT = 'Your keys are split between contacts you trust and a few independent nodes. Nobody can open your account alone.';

const store = useRecoveryBackupStore();
const $userPQ = userPQStore();
const $modal = inject('$modal');

const loadError = ref(null);
const busy = ref(false);
const actionError = ref(null);

const load = async () => {
	loadError.value = null;
	try {
		await store.load();
		// What the guardians said about their pieces: the health line counts the stored ones.
		if (store.run?.step === 'done') store.refreshReceipts().catch((e) => console.warn('[recovery] the guardians\' receipts could not be read:', e));
	} catch (e) {
		loadError.value = errorMessage(e);
	}
};
// An unfinished run may be driven by another device or tab: the card follows it.
onMounted(() => {
	if (!store.deployment) return;
	load();
	store.follow();
});
onUnmounted(() => {
	if (store.deployment) store.unfollow();
});

const run = computed(() => store.run);
const state = computed(() => {
	if (!store.deployment) return 'unavailable';
	if (!store.loaded) return 'loading';
	const step = run.value?.step;
	if (!step || step === 'discarded') return 'none';
	if (step === 'done') return 'done';
	return 'unfinished';
});

// --- No backup -------------------------------------------------------------

const agreed = computed(() => store.pickable);
const agreedText = computed(() => {
	const n = agreed.value.length;
	return n ? `${plural(n, 'guardian')} ${n === 1 ? 'has' : 'have'} agreed` : 'No guardian has agreed yet';
});
const createBlocked = computed(() => {
	const n = agreed.value.length;
	return n >= 2 ? null : `Create backup needs 2 guardians who agreed. ${2 - n} more to go.`;
});

// --- Unfinished --------------------------------------------------------------

/** The run being made — the first backup, or a reshare of the finished one — or null. */
const active = computed(() => (unfinished(store.current) ? store.current : null));
const changing = computed(() => !!active.value?.reshareOf);
const step = computed(() => (active.value ? stepNumber(active.value) : 1));
const stepLine = computed(() => `step ${step.value} of 6: ${STEP_LABELS[step.value - 1].toLowerCase()}`);
const elsewhere = computed(() => !store.runsHere);
const unfinishedTitle = computed(() => {
	const doing = changing.value ? 'changed' : 'created';
	if (store.running) return changing.value ? 'Changing your backup' : 'Creating your backup';
	if (store.heldElsewhere) return `Your backup is being ${doing} in another tab`;
	if (elsewhere.value) return `Your backup is being ${doing} on your ${active.value.device}`;
	return changing.value ? 'The change to your backup was not finished' : 'Your backup was not finished';
});
const unfinishedText = computed(() => {
	if (store.running) return `Now at ${stepLine.value}.`;
	if (store.canTakeOver) return `No progress for ${agoText(active.value.updatedAt).replace(/ ago$/, '')}, at ${stepLine.value}. If that device is lost or closed, continue here.`;
	if (elsewhere.value) return `Last seen at ${stepLine.value}. This device shows its progress and does not start a second ${changing.value ? 'change' : 'backup'}.`;
	return `Stopped at ${stepLine.value}.`;
});
const showDiscard = computed(() => !store.running && !elsewhere.value && !!active.value && canDiscard(active.value));
const continueLabel = computed(() => (store.running || elsewhere.value ? 'Show progress' : 'Continue'));

const cont = () => {
	const resume = !store.running && !elsewhere.value;
	open('progress');
	if (resume) store.resume().catch((e) => console.warn('[recovery] the backup could not continue:', e));
};
const takeOver = () => {
	open('progress');
	store.takeOver().catch((e) => console.warn('[recovery] the backup could not continue here:', e));
};
const discard = async () => {
	busy.value = true;
	actionError.value = null;
	try {
		await store.discard();
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

// --- Done ----------------------------------------------------------------------

const roster = computed(() => rosterView(run.value, store.receipts, store.receiptDetails, (h) => guardianName(h, store.candidates, $userPQ)));
const outsideAlerts = computed(() => hasOutsideAlerts(run.value?.alerts));
const healthExtra = computed(() => {
	const spares = plural(sparesLeft(run.value), 'spare piece');
	return outsideAlerts.value ? `${spares} · alerts: ${alertsText(run.value.alerts.channels)}` : spares;
});

/** A guardian's row colour: a stored piece is good, one on its way pending, one that no longer counts bad. */
const rosterTone = (g) => (g.lost ? 'bad' : g.state === 'stored' ? 'ok' : 'pending');

const open = (start) => {
	$modal.value.open({ id: 'community_backup', start });
};
</script>

<style lang="scss" scoped>
.cb-card {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);

	@media (min-width: 768px) {
		padding: var(--space-4) var(--space-5);
	}
}
.cb-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);

	i { width: 22px; height: 22px; background-color: var(--color-text); }
}
.cb-title {
	flex: 1;
	margin: 0;
	font-size: var(--text-lg);
	line-height: var(--leading-lg);
	font-weight: var(--weight-medium);
}
.cb-about {
	margin: 0;
	font-size: var(--text-sm);
	line-height: var(--leading-sm);
	color: var(--color-text-secondary);
}
.cb-notice {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}
.cb-notice-title { font-weight: var(--weight-medium); }
.cb-actions {
	display: flex;
	gap: var(--space-2);

	> * { flex: 1; }
}
.cb-error-text { color: var(--color-danger); }
.cb-agreed {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
.cb-card-faces {
	display: flex;
	> * + * { margin-left: -6px; }
}
.cb-card-slot {
	display: inline-block;
	width: 26px;
	height: 26px;
	border-radius: 50%;
	background: var(--color-bg);
	border: 2px dashed var(--color-border-strong);
}
.cb-roster {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;

	li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
}
.cb-roster-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cb-state-ok { color: var(--color-success); }
.cb-state-pending { color: var(--color-warning); }
.cb-state-bad { color: var(--color-danger); }
.cb-skel-line { height: 16px; width: 60%; }
.cb-skel-bar { height: 8px; }
</style>
