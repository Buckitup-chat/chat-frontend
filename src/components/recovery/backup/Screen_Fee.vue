<template>
	<ScreenHeader title="Network fee" back />

	<div v-if="tooBig" class="cb-warn" data-test="too-big">
		This backup has {{ guardianCount }} guardians. The free service takes up to {{ RELAYER_MAX_GUARDIANS }}, so it is paid from your address.
	</div>

	<div
		class="cb-tile"
		:class="{ pickable: !tooBig, picked: choice === 'buckitup', off: tooBig }"
		data-test="tile-buckitup"
		:aria-disabled="tooBig"
		@click="!tooBig && (choice = 'buckitup')"
	>
		<div class="cb-tile-head">
			<span class="cb-radio" :class="{ on: choice === 'buckitup' }"></span>
			<div class="d-flex flex-column gap-1">
				<span class="cb-tile-title">BuckitUp's service</span>
				<span class="cb-muted">{{ tooBig ? 'not available for this backup' : 'free' }}</span>
			</div>
		</div>
	</div>

	<div class="cb-tile pickable" :class="{ picked: choice === 'other' }" data-test="tile-other" @click="choice = 'other'">
		<div class="cb-tile-head">
			<span class="cb-radio" :class="{ on: choice === 'other' }"></span>
			<div class="d-flex flex-column gap-1">
				<span class="cb-tile-title">Another service</span>
				<span class="cb-muted">paid by whoever runs it</span>
			</div>
		</div>
		<div v-if="choice === 'other'" class="cb-tile-body" @click.stop>
			<input v-model="url" type="url" class="form-control" placeholder="https://" aria-label="Service address" />
		</div>
	</div>

	<div class="cb-tile pickable" :class="{ picked: choice === 'self' }" data-test="tile-self" @click="choice = 'self'">
		<div class="cb-tile-head">
			<span class="cb-radio" :class="{ on: choice === 'self' }"></span>
			<div class="d-flex flex-column gap-1">
				<span class="cb-tile-title">Pay yourself</span>
				<span class="cb-muted">from your own network address</span>
			</div>
		</div>
		<div v-if="choice === 'self'" class="cb-tile-body" @click.stop>
			<div v-if="quoteError" class="cb-field-error">Could not read the balance: {{ quoteError }}</div>
			<div v-else-if="!quote" class="cb-small"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Reading the balance…</div>
			<template v-else>
				<span class="cb-small">Your network address</span>
				<CopyField :value="quote.address" :shown="shortAddress(quote.address)" />
				<div class="d-flex justify-content-between small"><span>Balance</span><span data-test="balance">{{ amount(quote.balance) }} {{ CURRENCY }}</span></div>
				<div class="d-flex justify-content-between small"><span>Estimated fee</span><span>≈ {{ amount(quote.estimate) }} {{ CURRENCY }}</span></div>
				<div v-if="!quote.enough" class="cb-warn">Top up this address with at least {{ amount(quote.estimate) }} {{ CURRENCY }}.</div>
				<div class="cb-small">The fee is taken once, when the backup is registered. Nothing is published before you press Create.</div>
			</template>
		</div>
	</div>

	<div class="cb-actions">
		<button class="btn btn-dark w-100" :disabled="!!saveBlock" data-test="save" @click="save">Save</button>
		<div v-if="saveBlock" class="cb-small text-center" data-test="save-reason">{{ saveBlock }}</div>
	</div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { RELAYER_MAX_GUARDIANS } from '@/lib/recovery/backupPlan';
import ScreenHeader from './ScreenHeader.vue';
import CopyField from './CopyField.vue';
import { DRAFT, NAV, shortAddress } from './backupFlow';

/** The deployment's chain pays in ether. */
const CURRENCY = 'ETH';
const QUOTE_EVERY_MS = 20_000;

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();

const guardianCount = computed(() => draft.guardians.value.length);
const tooBig = computed(() => draft.freeTooSmall.value);
// Past the free service's limit the choice moves to paying yourself, and says why.
const choice = ref(draft.feeChoice.value);
const url = ref(draft.state.fee.url);

const quote = ref(draft.state.quote);
const quoteError = ref(null);
let timer = null;
const readQuote = async () => {
	try {
		quote.value = await store.selfPayQuote(guardianCount.value);
		draft.state.quote = quote.value;
		quoteError.value = null;
	} catch (e) {
		quoteError.value = e?.message ?? String(e);
	}
};
watch(
	choice,
	(c) => {
		clearInterval(timer);
		timer = null;
		if (c !== 'self') return;
		readQuote();
		// The balance updates by itself, so a top-up shows without a reload.
		timer = setInterval(readQuote, QUOTE_EVERY_MS);
	},
	{ immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));

const amount = (eth) => {
	const n = Number(eth);
	if (!Number.isFinite(n)) return eth;
	return n === 0 ? '0' : n < 0.0001 ? '< 0.0001' : String(Number(n.toPrecision(3)));
};

const saveBlock = computed(() => {
	if (choice.value === 'other' && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url.value.trim())) return 'Type the https address of the service that pays the fee.';
	if (choice.value === 'self') {
		if (quoteError.value) return 'The balance could not be read.';
		if (!quote.value) return 'Reading the balance…';
		if (!quote.value.enough) return 'Balance is too low for the fee.';
	}
	return null;
});

const save = () => {
	draft.state.fee = { choice: choice.value, url: url.value.trim() };
	nav.back();
};
</script>
