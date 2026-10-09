<template>
	<div v-if="visible" class="access-gate-banner">
		<span class="access-gate-text">
			Waiting for approval by the device owner
			<template v-if="userHash">· <span class="access-gate-hash" :title="userHash">{{ $filters.txHashShort(userHash) }}</span></template>
		</span>
		<button v-if="userHash" type="button" class="access-gate-action" @click="copyHash">Copy ID</button>
		<button type="button" class="access-gate-action" @click="checkAgain">Check again</button>
	</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { hasBlockedShapes, onBlockedChange, probeAllBlocked } from '@/lib/data/accessGate';
import { userPQStore } from '@/store/userPQ.store';
import copyToClipboard from '@/utils/copyToClipboard';

const $user = userPQStore();
const userHash = computed(() => $user.currentUserHash);

const visible = ref(hasBlockedShapes());

let unsub = null;

onMounted(() => {
	unsub = onBlockedChange(() => { visible.value = hasBlockedShapes(); });
});

onUnmounted(() => {
	if (unsub) unsub();
});

const checkAgain = () => probeAllBlocked();
const copyHash = () => copyToClipboard(userHash.value);
</script>

<style lang="scss" scoped>
.access-gate-banner {
	position: sticky;
	top: 0;
	z-index: 1500;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 10px;
	background: #fef3cd;
	border-bottom: 1px solid #d4a843;
}

.access-gate-text {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12px;
	color: #6a5a1f;
}

.access-gate-hash {
	font-family: monospace;
}

.access-gate-action {
	border: none;
	background: none;
	color: #8e6b2b;
	font-size: 12px;
	font-weight: 600;
	padding: 2px 6px;
	cursor: pointer;
	white-space: nowrap;
}
</style>
