<template>
	<ScreenHeader title="Community backup" />

	<div v-if="!run || run.step !== 'done'" class="cb-muted">There is no finished backup yet.</div>

	<!-- Revoked: nothing is left to manage -->
	<template v-else-if="run.revokedAt">
		<div class="cb-block" data-test="revoked">
			<span class="fw-semibold">Revoked for good</span>
			<span class="cb-muted">This backup was revoked on {{ dateText(run.revokedAt) }}. No recovery can use it, and your guardians drop their pieces.</span>
		</div>
		<button class="btn btn-outline-dark w-100" data-test="create-new" @click="createNew">Create a new backup</button>
	</template>

	<template v-else>
		<HealthLine :view="roster.health" />

		<div v-if="changing" class="cb-warn" data-test="blocked">
			<span>{{ FINISH_CHANGE_FIRST }}</span>
			<div><button class="btn btn-sm btn-outline-dark bg-white" data-test="show-change" @click="nav.go('progress')">Show the change</button></div>
		</div>

		<div v-for="p in prompts" :key="p.key" class="cb-warn" :data-test="p.key">
			<span>{{ p.text }}</span>
			<div>
				<button class="btn btn-sm btn-dark" :disabled="changing" :data-test="`${p.key}-cta`" @click="reshare">{{ p.action }}</button>
			</div>
		</div>

		<div v-if="!outsideAlerts" class="cb-warn" data-test="no-alerts">
			<span>No alerts. You may not learn about an attempt in time to stop it.</span>
			<div><button class="btn btn-sm btn-outline-dark bg-white" @click="nav.go('alerts')">Set up alerts</button></div>
		</div>

		<div v-if="actionError" class="cb-error" data-test="action-error">{{ actionError }}</div>

		<!-- Guardians -->
		<div class="cb-section">Guardians · version {{ run.version }}</div>
		<div class="cb-list">
			<div v-for="g in roster.rows" :key="g.userHash" class="cb-row" data-test="roster-row">
				<ContactAvatar :hash="g.userHash" />
				<span class="cb-row-main">
					<span class="cb-row-name">{{ g.name }}</span>
					<span v-if="g.spares" class="cb-small" data-test="spares-held">also holds {{ plural(g.spares, 'spare piece') }}</span>
					<span v-if="g.hint" class="cb-small" data-test="roster-hint">{{ g.hint }}</span>
					<span>
						<button
							class="cb-link small"
							:disabled="changing || !spares || giving !== null"
							:title="changing ? FINISH_CHANGE_FIRST : !spares ? 'No spare pieces are left.' : ''"
							data-test="give-spare"
							@click="giveSpare(g.userHash)"
						>
							<span v-if="giving === g.userHash" class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Give a spare piece
						</button>
					</span>
				</span>
				<span :class="g.state === 'stored' ? 'cb-status-ok' : g.hint ? 'cb-status-warn' : 'cb-small'" data-test="roster-state">{{ g.text }}</span>
			</div>
		</div>
		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">Spare pieces left</span>
				<span class="fw-semibold" data-test="spares-left">{{ spares }}</span>
			</div>
		</div>
		<div class="cb-small">Spare pieces are {{ SPARES_CAPTION }}. A spare gives a guardian a second piece to keep, not a second approval.</div>
		<button class="btn btn-outline-dark w-100" :disabled="changing" data-test="reshare" @click="reshare">Add or drop guardians, change pieces needed</button>

		<!-- Nodes -->
		<div class="cb-section">Nodes · {{ nodes.needed }} of {{ run.nodes.length }} needed</div>
		<div class="cb-group">
			<div v-for="n in nodes.rows" :key="n.id" class="cb-setting" data-test="node-row">
				<span class="flex-grow-1 d-flex flex-column gap-1">
					<span class="fw-medium">{{ n.name }}</span>
					<span class="cb-small">{{ n.host }}</span>
				</span>
				<span :class="n.cls">{{ n.text }}</span>
			</div>
		</div>

		<!-- The waiting period -->
		<div class="cb-section">Waiting period</div>
		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">Waiting period</span>
				<span class="fw-semibold" data-test="delay">{{ durationText(run.settings.delaySec) }}</span>
			</div>
			<div class="cb-setting">
				<span class="flex-grow-1">Time to finish after the wait</span>
				<span class="fw-semibold" data-test="window">{{ durationText(run.settings.windowSec) }}</span>
			</div>
		</div>
		<button class="btn btn-outline-dark w-100" :disabled="changing" data-test="change-policy" @click="nav.go('policy')">Change the waiting period</button>

		<!-- Alerts -->
		<div class="cb-section">Alerts</div>
		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">In the app</span>
				<span class="cb-small">always on</span>
			</div>
			<div v-for="sub in store.subs" :key="sub.id" class="cb-setting" data-test="subscription">
				<span class="flex-grow-1 d-flex flex-column gap-1">
					<span>{{ alertsText([sub.kind], { title: true }) }}</span>
					<span v-if="sub.createdAt" class="cb-small">since {{ dateText(Date.parse(sub.createdAt) / 1000) }}</span>
				</span>
				<button class="btn btn-sm btn-outline-dark" :disabled="removing !== null" data-test="remove-subscription" @click="remove(sub)">
					<span v-if="removing === sub.id" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
					<template v-else>Remove</template>
				</button>
			</div>
		</div>
		<div v-if="subsLoading" class="cb-small">Reading your alert channels…</div>
		<div v-if="subsError" class="cb-field-error" data-test="subs-error">Could not read your alert channels: {{ subsError }}</div>
		<div class="d-flex gap-2">
			<button class="btn btn-outline-dark flex-fill" data-test="add-channel" @click="nav.go('alerts')">Add a channel</button>
			<button class="btn btn-outline-dark flex-fill" data-test="open-history" @click="nav.go('history')">Alert history</button>
		</div>

		<!-- Revoke -->
		<div class="cb-section">Revoke</div>
		<template v-if="!confirmRevoke">
			<div class="cb-small">Revoking ends this backup for good: no recovery can ever use it, and it cannot be undone.</div>
			<button class="btn btn-outline-danger w-100" :disabled="changing" data-test="revoke" @click="confirmRevoke = true">Revoke for good…</button>
		</template>
		<div v-else class="cb-error" data-test="revoke-confirm">
			<span class="fw-semibold">Revoke this backup for good?</span>
			<span>No recovery can ever use it, your guardians drop their pieces, and this cannot be undone. Type {{ REVOKE_WORD }} to confirm.</span>
			<input v-model="revokeTyped" type="text" class="form-control form-control-sm" :aria-label="`Type ${REVOKE_WORD} to confirm`" autocomplete="off" data-test="revoke-input" />
			<div class="d-flex gap-2">
				<button class="btn btn-sm btn-outline-dark bg-white flex-fill" :disabled="revoking" @click="cancelRevoke">Keep the backup</button>
				<button class="btn btn-sm btn-danger flex-fill" :disabled="!revokeReady || revoking || changing" data-test="revoke-final" @click="revoke">
					<span v-if="revoking" class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Revoke for good
				</button>
			</div>
		</div>
	</template>

	<div class="cb-actions">
		<button class="btn btn-dark w-100" @click="nav.close()">Close</button>
	</div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { durationText, plural } from '@/lib/recovery/backupPlan';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import HealthLine from './HealthLine.vue';
import ContactAvatar from './ContactAvatar.vue';
import {
	DRAFT,
	FINISH_CHANGE_FIRST,
	NAV,
	SPARES_CAPTION,
	alertsText,
	changeInProgress,
	dateText,
	guardianName,
	hasOutsideAlerts,
	isLiveBackup,
	nodeRefName,
	nodesView,
	rosterView,
	sparesLeft,
} from './backupFlow';

// The owner's roster of a finished backup (plan § 7.4; pq_recovery_shares
// § What the owner sees): who holds a piece and how many are needed, the
// spares, the nodes and what they hold now, the waiting period and the alert
// channels — and the controls over it. A reshare goes through the setup
// screens filled in from the record; the controls wait while a change is
// being made, and a revoked backup has none.
const REVOKE_WORD = 'REVOKE';
/** How often the nodes' holdings are checked again while the roster is open. */
const HOLDINGS_EVERY_MS = 5 * 60_000;

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const run = computed(() => store.run);
const roster = computed(() => rosterView(run.value, store.receipts, store.receiptDetails, (h) => guardianName(h, store.candidates, $userPQ)));
const nodes = computed(() => nodesView(run.value, store.holdings, (n) => nodeRefName(n, store.nodes, $userPQ)));
const prompts = computed(() =>
	[roster.value.prompt && { key: 'reshare-prompt', ...roster.value.prompt }, nodes.value.prompt && { key: 'node-prompt', ...nodes.value.prompt }].filter(Boolean),
);
const outsideAlerts = computed(() => hasOutsideAlerts(run.value?.alerts));
const spares = computed(() => sparesLeft(run.value));
const changing = computed(() => changeInProgress(store));

// --- Controls ------------------------------------------------------------------

const actionError = ref(null);
const act = async (fn) => {
	actionError.value = null;
	try {
		await fn();
	} catch (e) {
		actionError.value = errorMessage(e);
	}
};

const reshare = () => {
	if (changing.value) return;
	draft.beginReshare(run.value);
	nav.refreshNodes({ once: true });
	nav.go('guardians');
};

const createNew = () => {
	draft.state.reshare = null;
	nav.refreshNodes({ once: true });
	nav.reset('guardians');
};

const giving = ref(null);
const giveSpare = async (userHash) => {
	if (changing.value || !spares.value) return;
	giving.value = userHash;
	await act(() => store.giveSpare(userHash));
	giving.value = null;
};

const confirmRevoke = ref(false);
const revokeTyped = ref('');
const revokeReady = computed(() => revokeTyped.value.trim() === REVOKE_WORD);
const revoking = ref(false);
const cancelRevoke = () => {
	confirmRevoke.value = false;
	revokeTyped.value = '';
};
const revoke = async () => {
	if (!revokeReady.value || changing.value) return;
	revoking.value = true;
	await act(async () => {
		await store.revoke();
		cancelRevoke();
	});
	revoking.value = false;
};

// --- Alerts ----------------------------------------------------------------------

const subsLoading = ref(false);
const subsError = ref(null);
const loadSubs = async () => {
	subsLoading.value = true;
	subsError.value = null;
	try {
		await store.subscriptions();
	} catch (e) {
		subsError.value = errorMessage(e);
	} finally {
		subsLoading.value = false;
	}
};

const removing = ref(null);
const remove = async (sub) => {
	removing.value = sub.id;
	await act(() => store.removeSubscription(sub.id));
	removing.value = null;
};

// --- What the nodes hold now ----------------------------------------------------------

const checkHoldings = () => store.checkHoldings().catch((e) => console.warn('[recovery] the nodes\' holdings could not be checked:', e));
let holdingsTimer = null;
let left = false;

onMounted(async () => {
	if (!store.loaded) await store.load().catch((e) => console.warn('[recovery] backup could not be read:', e));
	if (left || !isLiveBackup(store.run)) return;
	store.refreshReceipts().catch((e) => console.warn('[recovery] the guardians\' receipts could not be read:', e));
	loadSubs();
	checkHoldings();
	holdingsTimer = setInterval(checkHoldings, HOLDINGS_EVERY_MS);
});
onBeforeUnmount(() => {
	left = true;
	clearInterval(holdingsTimer);
});
</script>
