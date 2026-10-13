<template>
	<ScreenHeader title="Community backup" />

	<div v-if="!run || run.step !== 'done'" class="cb-muted">There is no finished backup yet.</div>

	<!-- Revoked: nothing is left to manage -->
	<div v-else-if="run.revokedAt" class="cb-block" data-test="revoked">
		<span class="fw-semibold">Revoked for good</span>
		<span class="cb-muted">This backup was revoked on {{ dateText(run.revokedAt) }}. No recovery can use it, and your guardians drop their pieces.</span>
	</div>

	<template v-else>
		<HealthLine :view="health" />

		<div v-if="changing" class="cb-warn" data-test="blocked">
			<span>A change to this backup is being made. Finish or discard the change first.</span>
			<div><button class="btn btn-sm btn-outline-dark bg-white" data-test="show-change" @click="nav.go('progress')">Show the change</button></div>
		</div>

		<div v-if="prompt" class="cb-warn" data-test="reshare-prompt">
			<span>{{ prompt.text }}</span>
			<div>
				<button class="btn btn-sm btn-dark" :disabled="!!blocked" data-test="reshare-cta" @click="reshare">{{ prompt.action }}</button>
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
			<div v-for="g in rows" :key="g.userHash" class="cb-row" data-test="roster-row">
				<ContactAvatar :hash="g.userHash" />
				<span class="cb-row-main">
					<span class="cb-row-name">{{ g.name }}</span>
					<span v-if="g.spares" class="cb-small" data-test="spares-held">also holds {{ plural(g.spares, 'spare piece') }}</span>
					<span v-if="g.hint" class="cb-small" data-test="roster-hint">{{ g.hint }}</span>
					<span>
						<button
							class="cb-link small"
							:disabled="!!blocked || !spares || giving !== null"
							:title="blocked || (!spares ? 'No spare pieces are left.' : '')"
							data-test="give-spare"
							@click="giveSpare(g.userHash)"
						>
							<span v-if="giving === g.userHash" class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Give a spare piece
						</button>
					</span>
				</span>
				<span :class="g.state === 'stored' ? 'cb-status-ok' : g.hint ? 'cb-status-warn' : 'cb-small'" data-test="roster-state">{{ ROSTER_TEXT[g.state] }}</span>
			</div>
		</div>
		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">Spare pieces left</span>
				<span class="fw-semibold" data-test="spares-left">{{ spares }}</span>
			</div>
		</div>
		<div class="cb-small">Spare pieces are {{ SPARES_CAPTION }}. A spare gives a guardian a second piece to keep, not a second approval.</div>
		<button class="btn btn-outline-dark w-100" :disabled="!!blocked" data-test="reshare" @click="reshare">Add or drop guardians, change pieces needed</button>

		<!-- Nodes -->
		<div class="cb-section">Nodes · {{ run.settings.nodeThreshold }} of {{ run.nodes.length }} needed</div>
		<div class="cb-group">
			<div v-for="n in nodeRows" :key="n.id" class="cb-setting" data-test="node-row">
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
		<button class="btn btn-outline-dark w-100" :disabled="!!blocked" data-test="change-policy" @click="nav.go('policy')">Change the waiting period</button>

		<!-- Alerts -->
		<div class="cb-section">Alerts</div>
		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">In the app</span>
				<span class="cb-small">always on</span>
			</div>
			<div v-for="sub in subs" :key="sub.id" class="cb-setting" data-test="subscription">
				<span class="flex-grow-1 d-flex flex-column gap-1">
					<span>{{ KIND_NAMES[sub.kind] ?? sub.kind }}</span>
					<span v-if="sub.createdAt" class="cb-small">since {{ dateText(sub.createdAt) }}</span>
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
			<button class="btn btn-outline-danger w-100" :disabled="!!blocked" data-test="revoke" @click="confirmRevoke = true">Revoke for good…</button>
		</template>
		<div v-else class="cb-error" data-test="revoke-confirm">
			<span class="fw-semibold">Revoke this backup for good?</span>
			<span>No recovery can ever use it, your guardians drop their pieces, and this cannot be undone. Type {{ REVOKE_WORD }} to confirm.</span>
			<input v-model="revokeTyped" type="text" class="form-control form-control-sm" :aria-label="`Type ${REVOKE_WORD} to confirm`" autocomplete="off" data-test="revoke-input" />
			<div class="d-flex gap-2">
				<button class="btn btn-sm btn-outline-dark bg-white flex-fill" :disabled="revoking" @click="cancelRevoke">Keep the backup</button>
				<button class="btn btn-sm btn-danger flex-fill" :disabled="!revokeReady || revoking || !!blocked" data-test="revoke-final" @click="revoke">
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
import { computed, inject, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { unfinished } from '@/lib/recovery/backupRun';
import { durationText, plural } from '@/lib/recovery/backupPlan';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import HealthLine from './HealthLine.vue';
import ContactAvatar from './ContactAvatar.vue';
import {
	DRAFT,
	LOST_STATES,
	NAV,
	SPARES_CAPTION,
	deliveryHint,
	guardianDelivery,
	guardianName,
	hasOutsideAlerts,
	healthView,
	hostOf,
	nodeRefName,
	sparesHeldBy,
	sparesLeft,
} from './backupFlow';

// The owner's roster of a finished backup (plan § 7.4; pq_recovery_shares
// § What the owner sees): who holds a piece and how many are needed, the
// spares, the nodes, the waiting period and the alert channels — and the
// controls over it. A reshare goes through the setup screens filled in from
// the record; the controls wait while a change is being made, and a revoked
// backup has none.
const ROSTER_TEXT = {
	stored: 'holds a piece',
	delivered: 'delivered',
	sent: 'sent',
	waiting: 'waiting for keys',
	problem: 'has a problem',
	given_back: 'gave it back',
	dropped: 'dropped it',
};
const KIND_NAMES = { telegram: 'Telegram', webhook: 'Webhook' };
const REVOKE_WORD = 'REVOKE';

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const run = computed(() => store.run);
const health = computed(() => healthView(run.value, store.receipts));
const outsideAlerts = computed(() => hasOutsideAlerts(run.value?.alerts));
const spares = computed(() => sparesLeft(run.value));
const dateText = (t) => new Date(typeof t === 'number' ? t * 1000 : t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A change of the backup is being made: every control waits for it (store.onFinished refuses too). */
const changing = computed(() => unfinished(store.reshare));
const blocked = computed(() => (changing.value ? 'Finish or discard the change first.' : null));

const rows = computed(() =>
	(run.value?.guardians ?? []).map((g) => {
		const state = guardianDelivery(run.value, g.userHash, store.receipts);
		return {
			userHash: g.userHash,
			name: guardianName(g.userHash, store.candidates, $userPQ),
			state,
			hint: deliveryHint(state, store.receiptDetails?.[g.userHash]?.detail),
			spares: sparesHeldBy(run.value, g.userHash),
		};
	}),
);

/** The call to reshare: pieces that no longer count, or a backup at or below what it needs. */
const prompt = computed(() => {
	const lost = rows.value.filter((r) => LOST_STATES.includes(r.state));
	const level = health.value.level;
	if (lost.length) {
		const names = lost.map((r) => r.name).join(', ');
		return {
			text: `${names} no longer ${lost.length === 1 ? 'keeps a piece' : 'keep a piece'} that counts. A reshare gives the guardians you pick new pieces and makes the old ones useless.`,
			action: 'Reshare to replace',
		};
	}
	if (level === 'broken') return { text: 'The backup does not work now: too few guardians keep their piece. Reshare it to guardians who will.', action: 'Reshare to replace' };
	if (level === 'at_threshold') return { text: 'One more lost piece and the backup stops working. Adding a guardian gives it a margin.', action: 'Add guardians' };
	return null;
});

const nodeRows = computed(() =>
	(run.value?.nodes ?? []).map((n) => {
		const outcome = run.value.nodeOutcomes?.[n.id]?.state;
		let text = 'waiting';
		let cls = 'cb-status-off';
		if (run.value.skippedNodes?.includes(n.id)) [text, cls] = ['left out', 'cb-status-warn'];
		else if (outcome === 'held' || outcome === 'staged') [text, cls] = ['holds its part', 'cb-status-ok'];
		else if (outcome === 'failed') [text, cls] = ['did not take its part', 'cb-status-warn'];
		return { id: n.id, name: nodeRefName(n, store.nodes, $userPQ), host: hostOf(n.url), text, cls };
	}),
);

// --- Controls ------------------------------------------------------------------

const actionError = ref(null);

const reshare = () => {
	if (blocked.value) return;
	draft.beginReshare(run.value);
	nav.refreshNodes();
	nav.go('guardians');
};

const giving = ref(null);
const giveSpare = async (userHash) => {
	if (blocked.value || !spares.value) return;
	giving.value = userHash;
	actionError.value = null;
	try {
		await store.giveSpare(userHash);
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		giving.value = null;
	}
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
	if (!revokeReady.value || blocked.value) return;
	revoking.value = true;
	actionError.value = null;
	try {
		await store.revoke();
		cancelRevoke();
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		revoking.value = false;
	}
};

// --- Alerts ----------------------------------------------------------------------

const subs = ref([]);
const subsLoading = ref(false);
const subsError = ref(null);
const loadSubs = async () => {
	subsLoading.value = true;
	subsError.value = null;
	try {
		subs.value = await store.subscriptions();
	} catch (e) {
		subsError.value = errorMessage(e);
	} finally {
		subsLoading.value = false;
	}
};

const removing = ref(null);
/** Removes a channel, and records what is left, so the card and this screen warn once none outside the app is. */
const remove = async (sub) => {
	removing.value = sub.id;
	actionError.value = null;
	try {
		await store.removeSubscription(sub.id);
		subs.value = subs.value.filter((s) => s.id !== sub.id);
		const channels = ['app', ...['telegram', 'webhook'].filter((k) => subs.value.some((s) => s.kind === k))];
		if (channels.join() !== (run.value.alerts?.channels ?? ['app']).join()) await store.setAlerts({ channels, skipped: false });
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		removing.value = null;
	}
};

onMounted(async () => {
	if (!store.loaded) await store.load().catch((e) => console.warn('[recovery] backup could not be read:', e));
	if (store.run?.step !== 'done' || store.run.revokedAt) return;
	store.refreshReceipts().catch((e) => console.warn('[recovery] the guardians\' receipts could not be read:', e));
	if (!store.nodes.length) nav.refreshNodes();
	loadSubs();
});
</script>
