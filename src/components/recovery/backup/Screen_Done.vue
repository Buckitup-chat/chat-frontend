<template>
	<ScreenHeader title="Community backup" />

	<template v-if="run && run.step === 'done'">
		<div v-if="draft.state.justFinished" class="cb-ok" data-test="created">Backup created. Every piece has been sent.</div>

		<HealthLine :view="health" guardians-word />

		<div class="cb-list">
			<div v-for="g in rows" :key="g.userHash" class="cb-row" data-test="roster-row">
				<Initials :name="g.name" :hash="g.userHash" />
				<span class="cb-row-main"><span class="cb-row-name">{{ g.name }}</span></span>
				<span :class="g.state === 'stored' ? 'cb-status-ok' : 'cb-small'">{{ ROSTER_TEXT[g.state] }}</span>
			</div>
		</div>

		<div class="cb-group">
			<div class="cb-setting">
				<span class="flex-grow-1">Spare pieces left</span>
				<span class="fw-semibold">{{ run.settings.spares }}</span>
			</div>
			<div class="cb-setting">
				<span class="flex-grow-1">Alerts</span>
				<span class="fw-semibold">{{ alertsLine }}</span>
			</div>
		</div>
		<div v-if="!outsideAlerts" class="cb-warn" data-test="no-alerts">
			<span>No alerts. You may not learn about an attempt in time to stop it.</span>
		</div>

		<div class="cb-actions">
			<button v-if="!outsideAlerts" class="btn btn-outline-dark w-100" @click="nav.go('alerts')">Set up alerts</button>
			<button class="btn btn-dark w-100" @click="nav.close()">Close</button>
		</div>
	</template>
	<div v-else class="cb-muted">There is no finished backup yet.</div>
</template>

<script setup>
import { computed, inject } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import ScreenHeader from './ScreenHeader.vue';
import HealthLine from './HealthLine.vue';
import Initials from './Initials.vue';
import { ALERT_NAMES, DRAFT, NAV, guardianDelivery, hasOutsideAlerts, healthView } from './backupFlow';

// The top of the roster (design 9.1); phase 7.4 builds the roster in full.
const ROSTER_TEXT = { stored: 'holds a piece', delivered: 'delivered', sent: 'sent', waiting: 'waiting for keys' };

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const run = computed(() => store.run);
const health = computed(() => healthView(run.value));
const outsideAlerts = computed(() => hasOutsideAlerts(run.value?.alerts));
const alertsLine = computed(() =>
	(run.value?.alerts?.channels ?? ['app'])
		.map((c) => ALERT_NAMES[c] ?? c)
		.map((t) => t[0].toUpperCase() + t.slice(1))
		.join(' · '),
);
const rows = computed(() =>
	(run.value?.guardians ?? []).map((g) => ({
		userHash: g.userHash,
		name: store.candidates.find((c) => c.userHash === g.userHash)?.name || $userPQ.contactsMap?.[g.userHash]?.name || 'Guardian',
		state: guardianDelivery(run.value, g.userHash),
	})),
);
</script>
