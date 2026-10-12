<template>
	<ScreenHeader title="Community backup" :step="1" step-label="Guardians" />

	<!-- 2.1: nobody has agreed yet -->
	<template v-if="!draft.agreed.value.length">
		<div class="cb-block" data-test="empty">
			<div class="cb-headline fs-6">Ask {{ askCount }} people you trust to be guardians</div>
			<div class="cb-muted">A guardian cannot open your account alone — they hold one piece of N. They help only when you ask them on a call.</div>
		</div>
	</template>

	<!-- 3.1: the picker -->
	<template v-else>
		<div class="cb-block" data-test="headline">
			<div class="cb-headline">{{ headline }}</div>
			<div class="cb-muted">{{ subline }}</div>
		</div>
		<div v-if="others.length" class="cb-section">Agreed · can be picked</div>
		<div class="cb-list">
			<div
				v-for="c in draft.agreed.value"
				:key="c.userHash"
				class="cb-row pickable"
				:class="{ picked: isPicked(c) }"
				role="checkbox"
				:aria-checked="isPicked(c)"
				data-test="agreed-row"
				@click="draft.toggle(c.userHash)"
			>
				<span class="cb-check" :class="{ on: isPicked(c) }">
					<svg v-if="isPicked(c)" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>
				</span>
				<Initials :name="c.name" :hash="c.userHash" />
				<span class="cb-row-main"><span class="cb-row-name">{{ c.name || 'Unnamed contact' }}</span></span>
				<span class="cb-status-ok">agreed</span>
			</div>
		</div>
	</template>

	<!-- 2.2: everyone else, with why not and what to do -->
	<template v-if="others.length">
		<div class="cb-section">{{ draft.agreed.value.length ? 'Not available yet' : 'Confirmed in person' }}</div>
		<div class="cb-list">
			<div v-for="c in others" :key="c.userHash" class="cb-row dim" data-test="other-row">
				<span class="cb-check none"></span>
				<Initials :name="c.name" :hash="c.userHash" muted />
				<span class="cb-row-main">
					<span class="cb-row-name">{{ c.name || 'Unnamed contact' }}</span>
					<span class="cb-row-sub">{{ STATUS_TEXT[c.status] }}</span>
					<span v-if="askErrors[c.userHash]" class="cb-field-error">{{ askErrors[c.userHash] }}</span>
				</span>
				<button v-if="c.status === 'waiting'" class="btn btn-sm btn-outline-dark" @click="remind(c)">Remind</button>
				<button v-else class="btn btn-sm btn-outline-dark" :disabled="!!asking[c.userHash]" @click="ask(c)">
					<span v-if="asking[c.userHash]" class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
					<template v-else>{{ c.status === 'declined' ? 'Ask again' : 'Ask' }}</template>
				</button>
			</div>
		</div>
	</template>
	<div v-if="store.hiddenContacts" class="cb-small">
		Only contacts confirmed in person can be guardians. {{ plural(store.hiddenContacts, 'other contact') }} {{ store.hiddenContacts === 1 ? 'is' : 'are' }} not shown.
	</div>

	<template v-if="draft.agreed.value.length">
		<!-- 3.1: two guardians are allowed, once the owner says they understand -->
		<div v-if="count === 2" class="cb-warn" data-test="two-warning">
			<span>If you lose either of them, the backup cannot be used.</span>
			<label class="d-flex align-items-center gap-2 text-dark">
				<input v-model="draft.state.twoAck" type="checkbox" class="form-check-input m-0" data-test="two-ack" />
				I understand, use 2 guardians
			</label>
		</div>

		<!-- 3.2: too few node operators -->
		<div v-if="count >= 2 && shortfall" class="cb-warn" data-test="operators-short">
			<div>
				<div class="fw-semibold">{{ plural(shortfall.need - shortfall.have, 'more node operator') }} needed</div>
				The node half must be held by at least {{ shortfall.need }} different people or organisations. {{ shortfall.have }} {{ shortfall.have === 1 ? 'is' : 'are' }} available now.
			</div>
			<div><button class="btn btn-sm btn-outline-dark bg-white" @click="addNode">Add node</button></div>
		</div>

		<!-- The defaults, folded -->
		<div class="cb-block p-0 overflow-hidden">
			<div class="d-flex align-items-center gap-2 px-3 py-2" role="button" @click="open = !open">
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="fw-semibold small">Settings</span>
					<span class="cb-small" data-test="summary">{{ draft.state.nodesLoading && !store.nodes.length ? 'Looking for nodes…' : draft.summaryLine.value }}</span>
				</div>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :style="{ transform: open ? 'rotate(180deg)' : '' }"><path d="M7 10l5 5 5-5"></path></svg>
			</div>
			<div v-if="open" class="d-flex flex-column gap-2 px-3 pb-3 small">
				<div>{{ count >= 2 ? `${headline} · ${subline}` : 'Pick at least 2 guardians' }}</div>
				<div>{{ plural(settings.spares, 'spare piece') }} kept in your account</div>
				<div>{{ settings.nodeThreshold }} of {{ draft.nodes.value.length }} nodes needed</div>
				<div>you have {{ durationText(settings.delaySec) }} to stop an attempt that is not yours</div>
				<div>Network fee: {{ draft.feeText.value }}</div>
				<div><button class="btn btn-sm btn-outline-dark" @click="nav.go('advanced')">Change settings</button></div>
			</div>
		</div>

		<div class="cb-actions">
			<button class="btn btn-dark w-100" :disabled="!!draft.blockReason.value" data-test="next" @click="nav.go('alerts')">Next: alerts</button>
			<div v-if="draft.blockReason.value" class="cb-small text-center" data-test="block-reason">{{ draft.blockReason.value }}</div>
		</div>
	</template>
</template>

<script setup>
import { computed, inject, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { useRecoveryInvitesStore } from '@/store/recoveryInvites.store';
import { durationText, neededGuardians } from '@/lib/recovery/backupPlan';
import ScreenHeader from './ScreenHeader.vue';
import Initials from './Initials.vue';
import { DRAFT, NAV, plural } from './backupFlow';

const STATUS_TEXT = { waiting: 'waiting for answer', declined: 'declined', not_asked: 'not asked' };

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const invites = useRecoveryInvitesStore();
const router = useRouter();

const open = ref(false);
const others = computed(() => store.candidates.filter((c) => c.status !== 'agreed' || !c.metaAddress));
const askCount = computed(() => Math.max(2, 3 - draft.agreed.value.length));
const count = computed(() => draft.guardians.value.length);
const settings = computed(() => draft.settings.value);
const shortfall = computed(() => (draft.state.nodesLoading ? null : draft.operatorShortfall.value));
const isPicked = (c) => draft.state.selected.includes(c.userHash);

const headline = computed(() => (count.value === 1 ? '1 guardian' : `${count.value} guardians`));
const subline = computed(() => (count.value >= 2 ? `any ${neededGuardians(settings.value)} of them can help you back in` : 'Pick at least 2. 3 or more is safer.'));

const asking = reactive({});
const askErrors = reactive({});
const ask = async (c) => {
	asking[c.userHash] = true;
	askErrors[c.userHash] = null;
	try {
		await invites.invite(c.userHash);
	} catch (e) {
		askErrors[c.userHash] = e?.message ?? String(e);
	} finally {
		asking[c.userHash] = false;
	}
};
const remind = (c) => {
	nav.close();
	router.push({ name: 'chat', params: { address: c.userHash } });
};
const addNode = () => nav.go('addNode');
</script>
