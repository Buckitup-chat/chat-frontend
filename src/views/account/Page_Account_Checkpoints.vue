<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="ui-title">Checkpoints</div>
		</template>
		<template #content>
			<div class="_page" :class="{ _split: panelPeer }">
				<p class="ui-small ui-secondary _intro">You'll see here if a dialog changes after you signed a checkpoint in it.</p>
				<div class="_list">
					<div v-if="isEmpty" class="ui-card _empty" data-test="checkpoints-empty">
						<div class="_tile"><i class="_icon_checkpoint"></i></div>
						<div class="ui-body _empty_title">No checkpoints yet</div>
						<p class="ui-small ui-secondary">
							Open a dialog and tap the checkpoint button at the top to sign its history as it is now. If anything in
							it changes later, you'll see it here.
						</p>
					</div>

					<template v-if="groups.changed.length">
						<div class="ui-group-label">Changed · {{ groups.changed.length }}</div>
						<div class="ui-card _card" data-test="checkpoints-changed">
							<UiRow v-for="e in groups.changed" :key="e.peerHash" :title="nameOf(e.peerHash)"
								:sub="summaryOf(e.peerHash) || 'Changed since the checkpoint'" tone="accent" dot="accent" button
								:selected="panelPeer === e.peerHash" :data-peer="e.peerHash" @select="openChanged(e)">
								<template #lead><ContactAvatar :hash="e.peerHash" class="_avatar" /></template>
								<template #meta>checkpoint {{ shortDayTime(e.createdAt) }}</template>
							</UiRow>
						</div>
					</template>

					<template v-if="groups.unchanged.length">
						<div class="ui-group-label">Unchanged · {{ groups.unchanged.length }}</div>
						<div class="ui-card _card" data-test="checkpoints-unchanged">
							<UiRow v-for="e in groups.unchanged" :key="e.peerHash" :title="nameOf(e.peerHash)" sub="Unchanged"
								tone="success" :data-peer="e.peerHash">
								<template #lead><ContactAvatar :hash="e.peerHash" class="_avatar" /></template>
								<template #meta>checkpoint {{ shortDayTime(e.createdAt) }}</template>
								<template #trail><i class="_icon_verified _ok"></i></template>
							</UiRow>
						</div>
					</template>

					<div v-if="checking" class="ui-card _card _loading" data-test="checkpoints-loading">
						<div v-for="p in skeletons" :key="p" class="_skel_row">
							<span class="ui-skeleton _skel_avatar"></span>
							<span class="_skel_lines"><span class="ui-skeleton _skel_line"></span><span class="ui-skeleton _skel_line _short"></span></span>
						</div>
						<div class="ui-caption ui-muted _checking">{{ checkingText }}</div>
					</div>

					<div v-if="failedCount" class="ui-card _error" data-test="checkpoints-error">
						<div class="_error_head">
							<i class="_icon_warning"></i>
							<div>
								<div class="ui-body">{{ failedTitle }}</div>
								<div class="ui-small ui-secondary">{{ failedText }}</div>
							</div>
						</div>
						<button type="button" class="ui-btn _outline _block" data-test="checkpoints-retry" @click="retry()">
							Try again <i class="_icon_reload"></i>
						</button>
					</div>

					<div class="_notes">
						<p class="ui-caption ui-secondary _info">
							<i class="_icon_info"></i>
							<span>Checkpoints you signed on another device appear here after you open that dialog on this one.</span>
						</p>
						<p v-if="!panelPeer && (groups.changed.length || groups.unchanged.length)" class="ui-caption ui-muted">
							A checkpoint fixes what this device had verified when you signed it. It does not prove nothing else existed
							elsewhere.
						</p>
					</div>
				</div>

				<!-- Desktop: the comparison beside the list, the same one the dialog shows. -->
				<section v-if="panelPeer" class="ui-card _panel" data-test="checkpoints-panel">
					<div class="_panel_head">
						<div class="_panel_title">
							<h2 class="ui-body">{{ nameOf(panelPeer) }} · since the checkpoint</h2>
							<div class="ui-caption ui-muted">{{ panelSub }}</div>
						</div>
						<button type="button" class="ui-btn _outline _sm" @click="openDialog(panelPeer)">Open dialog</button>
					</div>
					<CheckpointDiffBody v-if="panelComparison?.state === 'ready' && panelComparison.result.kind === 'diff'"
						:changes="panelChanges" :future-added="panelComparison.result.futureAdded"
						@jump="openDialog(panelPeer, panelEntry.messageId)" />
					<template v-else-if="panelComparison?.state === 'ready'">
						<p class="ui-notice _verdict">{{ panelComparison.result.text }}</p>
						<p class="ui-caption ui-muted">The dialog shows this checkpoint the same way when you tap it in the feed.</p>
					</template>
					<p v-else-if="panelComparison?.state === 'failed'" class="ui-notice _warning">
						The comparison didn't load on this device. Open the dialog to see it there.
					</p>
					<div v-else class="_panel_loading">
						<span class="ui-skeleton _skel_block"></span>
						<span class="ui-skeleton _skel_block"></span>
					</div>
				</section>
			</div>
		</template>
	</FullContentBlock>
</template>

<script setup>
import { computed, inject, ref, watch } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import UiRow from '@/components/ui/UiRow.vue';
import ContactAvatar from '@/components/recovery/backup/ContactAvatar.vue';
import CheckpointDiffBody from '@/components/chat/CheckpointDiffBody.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useCheckpointOverview } from '@/composables/useCheckpointOverview';
import { checkpointChangesLine, countCheckpointChanges } from '@/lib/data/checkpointSummary';
import { shortDayTime } from '@/lib/shortDate';
import { shortUserId } from '@/lib/shortUserId';

const $userPQ = userPQStore();
const $dialogs = useDialogsStore();
const $router = inject('$router');
const $breakpoint = useBreakpoint();
const isPhone = computed(() => $breakpoint.lt('md'));

// Every peer the account knows: the replicated cards and the contacts.
const peers = () => {
	const me = $userPQ.currentUserHash;
	const all = new Set([
		...($userPQ.allNetworkUsers ?? []).map((u) => u.user_hash),
		...Object.keys($userPQ.contactsMap ?? {}),
	]);
	all.delete(me);
	all.delete(undefined);
	return [...all].sort();
};

const { index, groups, pending, waiting, failed, comparisonOf, summaryOf, wantComparison, retry } =
	useCheckpointOverview($dialogs, peers);

const nameOf = (peerHash) =>
	$userPQ.contactsMap?.[peerHash]?.name || $userPQ.getUserByHash?.(peerHash)?.name || shortUserId(peerHash);

const checking = computed(() => index.value === 'loading' || pending.value.length > 0);
// Already-checked dialogs are in the lists; the rest wait as skeleton rows.
const skeletons = computed(() => (index.value === 'loading' ? ['index'] : waiting.value));
const checkingText = computed(() => {
	const n = pending.value.length;
	return n ? `Checking ${n} ${n === 1 ? 'dialog' : 'dialogs'}…` : 'Checking dialogs…';
});

const failedCount = computed(() => (index.value === 'failed' ? 1 : failed.value.length));
const failedTitle = computed(() => (index.value === 'failed'
	? "Couldn't read your checkpoints"
	: `Couldn't check ${failed.value.length} ${failed.value.length === 1 ? 'dialog' : 'dialogs'}`));
const failedText = computed(() => {
	if (index.value === 'failed') return "The list of your checkpoints didn't load on this device.";
	return `${failed.value.length === 1 ? 'Its history' : 'Their history'} didn't load on this device. The other results are up to date.`;
});

const isEmpty = computed(() => index.value === 'ready' && !checking.value && !failed.value.length
	&& !groups.value.changed.length && !groups.value.unchanged.length);

// ---------- the comparison ----------

const selected = ref(null);
// A desktop shows one changed dialog's comparison beside the list: the one
// picked, or the first.
const panelPeer = computed(() => {
	if (isPhone.value) return null;
	const changed = groups.value.changed;
	if (!changed.length) return null;
	return changed.some((e) => e.peerHash === selected.value) ? selected.value : changed[0].peerHash;
});
const panelEntry = computed(() => groups.value.changed.find((e) => e.peerHash === panelPeer.value) ?? null);
const panelComparison = computed(() => (panelPeer.value ? comparisonOf(panelPeer.value) : null));
watch(panelPeer, (peerHash) => { if (peerHash) wantComparison(peerHash); }, { immediate: true });

const panelChanges = computed(() => {
	const c = panelComparison.value;
	if (c?.state !== 'ready' || c.result.kind !== 'diff') return [];
	const me = $userPQ.currentUserHash;
	return c.result.changes.map((x) => ({ ...x, authorName: x.senderHash === me ? 'Me' : nameOf(panelPeer.value) }));
});
const panelSub = computed(() => {
	const when = panelEntry.value ? shortDayTime(panelEntry.value.createdAt) : '';
	const c = panelComparison.value;
	if (c?.state !== 'ready' || c.result.kind !== 'diff') return when;
	return `${when} · ${checkpointChangesLine(countCheckpointChanges(c.result.changes, c.result.futureAdded))}`;
});

/** The dialog; with a checkpoint, opened on its comparison (as the dialogs list's dot does). */
const openDialog = (peerHash, checkpoint = null) => $router.push({
	name: 'chat',
	params: { address: peerHash },
	...(checkpoint ? { query: { checkpoint } } : {}),
});

const openChanged = (entry) => {
	if (isPhone.value) openDialog(entry.peerHash, entry.messageId);
	else selected.value = entry.peerHash;
};
</script>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._page {
	width: 100%;
	max-width: 30rem;

	@include media-breakpoint-up(md) {
		max-width: 36rem;

		&._split {
			display: grid;
			grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
			align-items: start;
			column-gap: var(--space-6);
			max-width: 56rem;
		}
	}
}

._intro {
	margin: 0 0 var(--space-2);

	._split > & { grid-column: 1 / -1; margin: 0; }
}

._list > .ui-group-label { margin: var(--space-4) 0 var(--space-2); }

._card {
	padding: var(--space-1) 0;

	:deep(.ui-row) { min-height: 72px; }
	:deep(._lead) { background: transparent; }
}

._avatar._avatar {
	width: 40px;
	height: 40px;
}

._ok {
	flex-shrink: 0;
	width: 20px;
	height: 20px;
	background-color: var(--color-success);
}

._empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	margin-top: var(--space-4);
	padding: var(--space-6) var(--space-5);
	text-align: center;

	p { margin: 0; max-width: 26rem; }
}

._tile {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 48px;
	height: 48px;
	border-radius: var(--radius-input);
	background: var(--color-accent-tint);

	i { width: 24px; height: 24px; background-color: var(--color-accent); }
}

._empty_title { font-weight: var(--weight-medium); }

._loading {
	margin-top: var(--space-4);
	padding: var(--space-3) var(--space-4);
}

._skel_row {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-height: 56px;
}

._skel_avatar {
	flex-shrink: 0;
	width: 40px;
	height: 40px;
	border-radius: 50%;
}

._skel_lines {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

._skel_line {
	height: 12px;
	width: 60%;

	&._short { width: 40%; }
}

._checking { margin-top: var(--space-2); }

._error {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	margin-top: var(--space-4);
	padding: var(--space-4);
}

._error_head {
	display: flex;
	align-items: flex-start;
	gap: var(--space-3);

	i { flex-shrink: 0; width: 20px; height: 20px; margin-top: 2px; background-color: var(--color-danger); }
}

._notes {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	margin-top: var(--space-4);
	padding: 0 var(--space-1);

	p { margin: 0; }
}

._info {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);

	i { flex-shrink: 0; width: 16px; height: 16px; background-color: var(--color-text-muted); }
}

._panel {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4) var(--space-5);
	margin-top: var(--space-4);

	p { margin: 0; }
}

._panel_head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--space-3);

	.ui-btn { flex-shrink: 0; }
}

._panel_title {
	min-width: 0;

	h2 { margin: 0; font-weight: var(--weight-medium); }
}

._verdict { white-space: pre-wrap; }

._panel_loading {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

._skel_block { height: 72px; border-radius: var(--radius-input); }
</style>
