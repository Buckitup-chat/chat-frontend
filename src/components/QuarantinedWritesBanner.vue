<template>
	<div v-if="entries.length || blockedIssues.length" class="quarantine-banner">
		<div v-for="entry in entries" :key="entry.id" class="quarantine-banner-row">
			<span class="quarantine-banner-text">
				{{ labelFor(entry.relation) }} could not be delivered — {{ entry.lastError || 'rejected by the server' }}
			</span>
			<button type="button" class="quarantine-banner-action" @click="retry(entry.id)">Retry</button>
			<button type="button" class="quarantine-banner-action quarantine-banner-discard" @click="discard(entry.id)">Discard</button>
		</div>
		<div v-for="issue in blockedIssues" :key="issue.entry.id" class="quarantine-banner-row quarantine-banner-row--blocked">
			<span class="quarantine-banner-text">
				{{ blockedText(issue) }}
				<template v-if="blockerLastError(issue.blockers)">: {{ blockerLastError(issue.blockers) }}</template>
			</span>
			<button type="button" class="quarantine-banner-action quarantine-banner-discard" @click="discard(issue.entry.id)">Discard</button>
		</div>
	</div>
</template>

<script setup>

import { ref, watch, onMounted, onUnmounted } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { quarantinedEntries, requeueEntry, discardEntry, blockedDependentIssues } from '@/lib/data/outbox';

const POLL_MS = 10_000;

const RELATION_LABELS = {
	dialog_messages: 'A message',
	dialog_message_reactions: 'A reaction',
	dialog_message_receipts: 'A read receipt',
	dialog_keys: 'A dialog key',
	user_storage: 'A profile/contacts update',
	user_cards: 'Your profile card',
};
const labelFor = (relation) => RELATION_LABELS[relation] || 'A change';

const blockerReason = (blockers) => {
	const quarantinedCount = blockers.filter((b) => b.status === 'quarantined').length;
	const discardedCount = blockers.filter((b) => b.status === 'discarded').length;
	const unknownCount = blockers.filter((b) => b.status === 'unknown').length;
	const parts = [];
	if (quarantinedCount) parts.push(quarantinedCount === 1 ? 'a failed prerequisite' : `${quarantinedCount} failed prerequisites`);
	if (discardedCount) parts.push(discardedCount === 1 ? 'a discarded prerequisite' : `${discardedCount} discarded prerequisites`);
	if (unknownCount) parts.push(unknownCount === 1 ? 'an unresolvable prerequisite' : `${unknownCount} unresolvable prerequisites`);
	return parts.join(' and ');
};

const blockedText = (issue) => {
	const label = labelFor(issue.entry.relation);
	const quarantinedCount = issue.blockers.filter((b) => b.status === 'quarantined').length;
	const discardedCount = issue.blockers.filter((b) => b.status === 'discarded').length;
	const unknownCount = issue.blockers.filter((b) => b.status === 'unknown').length;

	if (quarantinedCount && !discardedCount && !unknownCount) {
		const subject = quarantinedCount === 1 ? 'a failed prerequisite' : `${quarantinedCount} failed prerequisites`;
		const verb = quarantinedCount === 1 ? 'is' : 'are';
		return `${label} is waiting on ${subject} — it will be sent once ${verb === 'is' ? 'it is' : 'they are'} successfully retried`;
	}
	if (discardedCount && !quarantinedCount && !unknownCount) {
		const subject = discardedCount === 1 ? 'a discarded prerequisite' : `${discardedCount} discarded prerequisites`;
		return `${label} will not be sent unless you take a separate, explicit action on ${subject}`;
	}
	if (unknownCount && !quarantinedCount && !discardedCount) {
		const subject = unknownCount === 1 ? 'a prerequisite that could not be found' : `${unknownCount} prerequisites that could not be found`;
		return `${label} is blocked by ${subject} — this needs investigation, not a simple Retry`;
	}
	return `${label} is blocked by ${blockerReason(issue.blockers)} — it will be sent only once every blocker above is resolved`;
};

const blockerLastError = (blockers) => {
	const withReason = blockers.map((b) => b.lastError).filter(Boolean);
	return withReason.length ? withReason[withReason.length - 1] : null;
};

const $userPQ = userPQStore();
const entries = ref([]);
const blockedIssues = ref([]);

let refreshGeneration = 0;
let unmounted = false;

const refresh = async () => {
	const generation = ++refreshGeneration;
	const userHash = $userPQ.currentUserHash;
	const [quarantined, blocked] = userHash
		? await Promise.all([quarantinedEntries(userHash), blockedDependentIssues(userHash)])
		: [[], []];

	if (unmounted || generation !== refreshGeneration || $userPQ.currentUserHash !== userHash) return;

	entries.value = quarantined;
	blockedIssues.value = blocked;
};

const retry = async (id) => {
	await requeueEntry(id);
	await refresh();
};

const discard = async (id) => {
	await discardEntry(id);
	await refresh();
};

let pollTimer = null;

watch(() => $userPQ.currentUserHash, refresh, { immediate: true });

onMounted(() => {
	pollTimer = setInterval(refresh, POLL_MS);
});

onUnmounted(() => {
	unmounted = true;
	if (pollTimer) clearInterval(pollTimer);
});

defineExpose({ refresh });
</script>

<style lang="scss" scoped>
.quarantine-banner {
	position: sticky;
	top: 0;
	z-index: 1500;
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 6px 10px;
	background: #fff3f0;
	border-bottom: 1px solid #e0a698;
}

.quarantine-banner-row {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 12px;
	color: #7a2e1f;
}

.quarantine-banner-row--blocked {
	color: #6a5a1f;
}

.quarantine-banner-text {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.quarantine-banner-action {
	border: none;
	background: none;
	color: #8e2b77;
	font-size: 12px;
	font-weight: 600;
	padding: 2px 6px;
	cursor: pointer;
	white-space: nowrap;
}

.quarantine-banner-discard {
	color: #a33b2a;
}
</style>
