<template>
	<section class="ui-card sk-card" data-test="shares-i-keep">
		<div class="sk-head">
			<i class="_icon_shares"></i>
			<h2>Shares I keep</h2>
		</div>
		<p class="sk-about">Pieces of your contacts' backups. If one of them loses access, their piece helps them back in.</p>

		<div v-if="loadError" class="cb-muted" data-test="load-error">
			Could not read the pieces you keep: {{ loadError }}
			<button type="button" class="ui-btn _text _sm" @click="load">Try again</button>
		</div>
		<div v-else-if="!store.loaded" class="ui-skeleton sk-skel"></div>
		<div v-else-if="!rows.length" class="cb-muted" data-test="empty">
			You keep no one's backup piece. When a contact you agreed to guard backs up, their piece appears here.
		</div>
		<template v-else>
			<div class="cb-list">
				<div v-for="r in rows" :key="r.key" class="cb-row sk-row" :class="{ dim: !r.kept }" data-test="kept-row">
					<ContactAvatar :hash="r.owner" :muted="!r.kept" />
					<span class="cb-row-main">
						<span class="cb-row-name">{{ r.name }}</span>
						<span class="cb-row-sub">Version {{ r.version }} · piece {{ r.shareIndex }}</span>
						<span :class="r.problem ? 'cb-status-warn' : r.state === 'stored' ? 'cb-status-ok' : 'cb-small'" data-test="kept-state">{{ r.stateText }}</span>
					</span>
					<button v-if="r.kept" type="button" class="ui-btn _outline _sm" :disabled="busy" data-test="give-back" @click="giveBack(r)">Give back</button>
				</div>
			</div>
			<div class="cb-small">Each piece is listed under the contact who sent it: the network does not say whose backup it belongs to.</div>
		</template>
		<!-- The way back: a contact who lost every device asks this guardian for their piece (plan § 7.5). -->
		<button v-if="help.deployment && help.helpable.length" type="button" class="ui-btn" data-test="help-someone" @click="openHelp()">Help someone recover</button>
		<div v-if="help.list.length" class="cb-list" data-test="helping">
			<div class="cb-small fw-semibold">Recoveries you help with</div>
			<div v-for="s in help.list" :key="s.key" class="cb-row sk-row" data-test="help-row">
				<ContactAvatar :hash="s.owner" small />
				<span class="cb-row-main">
					<span class="cb-row-name">{{ nameOf(s.owner) }}</span>
					<span :class="helpNeedsYou(s) ? 'cb-status-warn' : s.step === 'sent' ? 'cb-status-ok' : 'cb-small'" data-test="help-state">{{ helpStateText(s) }}</span>
				</span>
				<button v-if="s.step === 'ready'" type="button" class="ui-btn _sm" data-test="help-make" @click="openHelp(s.key)">Make the piece</button>
			</div>
		</div>
		<div v-if="actionError" class="cb-field-error" data-test="action-error">{{ actionError }}</div>
		<div v-if="notice" class="cb-small" data-test="notice">{{ notice }}</div>
	</section>
</template>

<script setup>
// The guardian's view of what they keep (pq_recovery_shares § Holding, "can
// see it in one place"), read from the copies in their own slot. Shown, it
// also checks them on chain: the Backup page is one of the sweep's triggers.
import { computed, inject, onMounted, ref } from 'vue';
import { useRecoveryHoldingsStore } from '@/store/recoveryHoldings.store';
import { userPQStore } from '@/store/userPQ.store';
import { holdsBytes } from '@/lib/recovery/holdings';
import errorMessage from '@/utils/errorMessage';
import ContactAvatar from './backup/ContactAvatar.vue';
import { confirmGiveBack, givenBackOffline, keptStateIsProblem, keptStateText } from './holdingWords';
import { helpNeedsYou, helpStateText } from './help/helpWords';
import { useRecoveryHelpStore } from '@/store/recoveryHelp.store';
import { nameOf as accountName } from './backup/backupFlow';

const store = useRecoveryHoldingsStore();
const $userPQ = userPQStore();
const $swal = inject('$swal');
const $modal = inject('$modal', null);
const help = useRecoveryHelpStore();

/** Opens the help: a new one, or the piece to make for a help returned by hand. */
const openHelp = (sessionKey = null) => $modal?.value?.open({ id: 'recovery_help', ...(sessionKey ? { sessionKey } : {}) });

const loadError = ref(null);
const actionError = ref(null);
const notice = ref(null);
const busy = ref(false);

const load = async () => {
	loadError.value = null;
	// One read of the slot per visit: the sweep's when it has something to
	// do or this session has not read the slot yet, a fresh one otherwise.
	let read = false;
	try {
		({ read } = await store.sweep({ force: true }));
	} catch (e) {
		console.warn('[recovery] the shares kept could not be checked:', e);
	}
	try {
		if (!read) await store.load({ refresh: true });
	} catch (e) {
		loadError.value = errorMessage(e);
	}
};
onMounted(() => {
	load();
	help.tick().catch((e) => console.warn('[recovery] a piece could not be sent:', e));
});

/** The dialog peer's name: whose claim the holding is. */
const nameOf = (userHash) => accountName(userHash, $userPQ);

const rows = computed(() =>
	store.list.map((h) => ({
		key: h.key,
		owner: h.owner,
		name: nameOf(h.owner),
		version: h.share.version,
		shareIndex: h.share.shareIndex,
		state: h.state,
		stateText: keptStateText(h.state, h.detail),
		problem: keptStateIsProblem(h.state),
		/** Its bytes are here: it can be given back. */
		kept: holdsBytes(h),
	})),
);

const giveBack = async (r) => {
	actionError.value = null;
	notice.value = null;
	if (!(await confirmGiveBack($swal, r.name))) return;
	busy.value = true;
	try {
		const { queued } = await store.giveBack(r.key);
		if (queued) notice.value = givenBackOffline(r.name);
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};
</script>

<style lang="scss" scoped>
@import './backup/tokens';
@include cb-tokens;

.sk-card {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);

	@media (min-width: 768px) {
		padding: var(--space-4) var(--space-5);
	}
}
.sk-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);

	i { width: 22px; height: 22px; background-color: var(--color-text); }

	h2 {
		margin: 0;
		font-size: var(--text-lg);
		line-height: var(--leading-lg);
		font-weight: var(--weight-medium);
	}
}
.sk-about {
	margin: 0;
	font-size: var(--text-sm);
	line-height: var(--leading-sm);
	color: var(--color-text-secondary);
}
.sk-skel { height: 40px; }
.sk-row {
	background: var(--color-surface);
}
</style>
