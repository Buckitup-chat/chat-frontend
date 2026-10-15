<template>
	<div class="cb rs" data-test="recover-screen">
		<div class="cb-head">
			<div class="cb-title">Recovering your account</div>
			<div class="cb-muted">This device has a temporary account. Your guardians send your backup pieces to it, and then you are back in your own account.</div>
		</div>

		<!-- 1. The code a guardian needs -->
		<div class="cb-block" data-test="code">
			<div class="cb-section">1. Call a guardian and give them this code</div>
			<CopyField v-if="store.temporary" :value="store.temporary" :shown="shortCode" />
			<div class="cb-small">In their app they open Backup → Shares I keep → Help someone recover, and paste it.</div>
		</div>

		<!-- 2. The words -->
		<div v-if="view?.words" class="cb-block" data-test="words">
			<div class="cb-section">2. Read these words to your guardian</div>
			<ol class="cb-words">
				<li v-for="(w, i) in view.words" :key="i">{{ w }}</li>
			</ol>
			<div class="cb-small">Their screen shows the same ten words if the request really comes from this device. Guardians who asked: {{ askedBy }}.</div>
		</div>

		<div v-if="view?.problem" class="cb-error" data-test="problem">{{ view.problem }}</div>

		<!-- 3. The round -->
		<div class="cb-block" data-test="round">
			<div class="cb-section">{{ phase.title }}</div>
			<div class="cb-muted">{{ phase.body }}</div>
			<button v-if="restartable" class="btn btn-dark" :disabled="busy" data-test="restart" @click="restart">Start over with a new key</button>
		</div>

		<!-- 4. The pieces -->
		<div v-if="pieces.length || view?.nodes?.length" class="cb-block" data-test="pieces">
			<div class="cb-section">Pieces {{ countLine }}</div>
			<div class="cb-list">
				<div v-for="(p, i) in pieces" :key="'p' + i" class="cb-row" data-test="piece">
					<ContactAvatar :hash="p.sender" small />
					<span class="cb-row-main">
						<span class="cb-row-name">{{ store.nameOf(p.sender) }}</span>
						<span :class="p.ok ? 'cb-status-ok' : 'cb-status-warn'" data-test="piece-state">{{ p.text }}</span>
					</span>
				</div>
				<div v-for="n in view?.nodes ?? []" :key="n.node.id" class="cb-row" data-test="node">
					<span class="cb-row-main">
						<span class="cb-row-name">Node {{ hostOf(n.node.url) }}</span>
						<span :class="n.state === 'released' ? 'cb-status-ok' : 'cb-status-off'">{{ nodeStateText(n) }}</span>
					</span>
				</div>
			</div>
		</div>

		<div v-if="view?.ready" class="cb-ok" data-test="ready">
			<div>Enough pieces are here to open your account.</div>
			<button class="btn btn-dark" :disabled="store.opening" data-test="open" @click="open">
				<span v-if="store.opening" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Open my account
			</button>
			<div class="cb-small">Opening it asks for this device's passkey.</div>
		</div>
		<div v-if="store.openError" class="cb-error" data-test="open-error">{{ store.openError }}</div>

		<ManualReturnPanel />

		<div class="d-flex align-items-center gap-2 cb-small">
			<span v-if="store.lastError" class="cb-field-error" data-test="check-error">Could not look just now: {{ store.lastError }}</span>
			<span v-else-if="store.checking">Looking…</span>
			<button class="btn btn-link btn-sm p-0 ms-auto" :disabled="store.checking" @click="store.check()">Check now</button>
			<button class="btn btn-link btn-sm p-0 text-danger" data-test="abandon" @click="abandon">Give up</button>
		</div>
	</div>
</template>

<script setup>
// The recovering device's one screen (plan § 7.5): the code to pass a
// guardian, the ten words, the round, each piece as verified or set aside
// with its sender named, the nodes, and the way into the original account.
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRecoveryRestoreStore } from '@/store/recoveryRestore.store';
import { canRestart } from '@/lib/recovery/restoring';
import errorMessage from '@/utils/errorMessage';
import CopyField from '../backup/CopyField.vue';
import { hostOf } from '../backup/backupFlow';
import ContactAvatar from '../backup/ContactAvatar.vue';
import ManualReturnPanel from './ManualReturnPanel.vue';
import { nodeStateText, phaseText } from './restoreWords';

const store = useRecoveryRestoreStore();
const $swal = inject('$swal', null);
const $mitt = inject('$mitt', null);
const $router = inject('$router', null);

const now = ref(Math.floor(Date.now() / 1000));
let tick = null;
onMounted(() => {
	store.startWatching();
	tick = setInterval(() => (now.value = Math.floor(Date.now() / 1000)), 30_000);
});
onUnmounted(() => {
	store.stopWatching();
	clearInterval(tick);
});

const view = computed(() => store.view);
const shortCode = computed(() => `${store.temporary.slice(0, 14)}…${store.temporary.slice(-6)}`);
const askedBy = computed(() => {
	const names = [...new Set((view.value?.requests ?? []).map((r) => (r.peer ? store.nameOf(r.peer) : 'by text')))];
	return names.join(', ') || 'none yet';
});
const phase = computed(() => phaseText(view.value?.round ?? null, view.value?.approvals, now.value));
const restartable = computed(() => !!view.value?.round && canRestart(view.value.round.phase));

const pieces = computed(() => {
	const r = view.value?.returns;
	if (!r) return [];
	return [
		...r.verified.map((v) => ({ sender: v.sender, ok: true, text: `piece ${v.index} verified${v.via === 'text' ? ' (sent as text)' : ''}` })),
		...r.setAside.map((s) => ({ sender: s.sender, ok: false, text: `set aside: ${s.reason}` })),
	];
});
const countLine = computed(() => {
	const v = view.value;
	if (!v?.returns?.threshold) return '';
	const need = v.returns.nodeSet?.threshold;
	const nodes = need ? ` · nodes ${v.nodeShares} of ${need}` : '';
	return `· ${v.returns.distinct} of ${v.returns.threshold}${nodes}`;
});
const busy = ref(false);
const restart = async () => {
	busy.value = true;
	try {
		await store.restart();
	} catch (e) {
		$swal?.fire({ icon: 'error', title: 'Could not start over', text: errorMessage(e) });
	} finally {
		busy.value = false;
	}
};

const open = async () => {
	try {
		await store.openAccount();
		$mitt?.emit('account::created');
		$router?.replace({ name: 'account_info' });
		$swal?.fire({ icon: 'success', title: 'You are back in your account', text: 'One more step: renew your backup.', timer: 6000 });
	} catch (e) {
		console.error('[recovery] the account could not be opened:', e);
	}
};

const abandon = async () => {
	const answer = await $swal?.fire({
		icon: 'warning',
		title: 'Give up this recovery?',
		text: 'The temporary account and its key are removed from this device. Pieces your guardians already sent to it cannot be used again.',
		showCancelButton: true,
		confirmButtonText: 'Give up',
		cancelButtonText: 'Back',
	});
	if (answer?.isConfirmed) await store.abandon();
};
</script>

<style lang="scss" scoped>
@import '../backup/tokens';
@include cb-tokens;

.rs {
	display: flex;
	flex-direction: column;
	gap: 14px;
	width: 100%;
	max-width: 32rem;
	margin: 0 auto;
	padding: 24px 12px;
	font-size: 14px;
	color: #241824;
	background: #fff;
	border-radius: 16px;
}
.cb-head {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
</style>
