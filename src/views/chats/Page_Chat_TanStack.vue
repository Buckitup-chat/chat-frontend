<template>
	<div class="h-100 w-100 position-relative">
		<div class="_poc_badge">
			<div><b>TanStack DB PoC</b></div>
			<div>shape ready: {{ stats.preloadMs ?? '…' }} ms</div>
			<div>rows: {{ stats.rows }}</div>
			<div v-if="stats.lastRoundTripMs">send→shape: {{ stats.lastRoundTripMs }} ms</div>
		</div>
		<ChatWindow :title="chatName + ' (PoC)'" :avatarUrl="''" :avatarHash="peerHash || ''" :messages="decryptedMessages"
			:showAuthorName="false" :reactions="[]" @sendMessage="handleSendMessage" />
	</div>
</template>

<style lang="scss" scoped>
._poc_badge {
	position: absolute;
	top: 0.5rem;
	right: 0.5rem;
	z-index: 10;
	background: rgba(0, 0, 0, 0.75);
	color: #9f9;
	font-size: 0.75rem;
	font-family: monospace;
	padding: 0.4rem 0.6rem;
	border-radius: 0.4rem;
	pointer-events: none;
}
</style>

<script setup>
import { ref, computed, watch, onBeforeUnmount, reactive } from 'vue';
import { useRoute } from 'vue-router';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { getDialogMessagesCollection } from '@/lib/tanstack/dialogMessages';
import { v7 as uuidv7 } from 'uuid';

const $route = useRoute();
const $userPQ = userPQStore();
const $dialogs = useDialogsStore();

const peerHash = computed(() => $route.params.address);
const dialogHash = computed(() => $dialogs.getDialogHash(peerHash.value));

const chatName = computed(() => {
	const address = peerHash.value;
	if (!address) return 'User';
	const contact = $userPQ.contacts.find((e) => e.user_hash === address) || $userPQ.getUserByHash(address);
	return contact?.name || address;
});

const stats = reactive({ preloadMs: null, rows: 0, lastRoundTripMs: null });
const decryptedMessages = ref([]);
const messageCache = new Map();
const pendingSends = new Map(); // message_id -> performance.now() at send
let unsubscribe = null;

const rebuild = async (rows) => {
	const sorted = [...rows].sort((a, b) => (a.owner_timestamp || 0) - (b.owner_timestamp || 0));
	const out = [];
	for (const row of sorted) {
		if (row.deleted_flag) continue;

		if (pendingSends.has(row.message_id)) {
			stats.lastRoundTripMs = Math.round(performance.now() - pendingSends.get(row.message_id));
			console.log(`[tanstack PoC] send→shape round trip: ${stats.lastRoundTripMs} ms`);
			pendingSends.delete(row.message_id);
		}

		let entry = messageCache.get(row.message_id);
		if (!entry || entry._contentB64 !== row.content_b64) {
			const t0 = performance.now();
			let decrypted;
			try {
				decrypted = await $dialogs.decryptMessageRow(row);
			} catch (e) {
				console.warn('[tanstack PoC] decrypt failed for', row.message_id, e);
				decrypted = { text: '[decrypt failed]', isMine: false };
			}
			const date = new Date(row.owner_timestamp * 1000);
			entry = {
				id: row.message_id,
				text: decrypted.text,
				authorName: decrypted.isMine ? 'Me' : chatName.value,
				isMine: decrypted.isMine,
				timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
				_syncStatus: 'synced',
				_contentB64: row.content_b64,
				_raw: row,
			};
			messageCache.set(row.message_id, entry);
			if (performance.now() - t0 > 50) console.log(`[tanstack PoC] slow decrypt ${Math.round(performance.now() - t0)}ms for ${row.message_id}`);
		}
		out.push(entry);
	}
	decryptedMessages.value = out;
	stats.rows = out.length;
};

const attach = async (hash) => {
	if (unsubscribe) { unsubscribe(); unsubscribe = null; }
	messageCache.clear();
	decryptedMessages.value = [];
	stats.preloadMs = null;
	if (!hash) return;

	const coll = getDialogMessagesCollection(hash);

	const t0 = performance.now();
	await coll.preload();
	stats.preloadMs = Math.round(performance.now() - t0);
	console.log(`[tanstack PoC] shape ready in ${stats.preloadMs} ms, ${coll.size} rows`);

	await rebuild(coll.toArray);
	unsubscribe = coll.subscribeChanges(() => {
		const t = performance.now();
		rebuild(coll.toArray).then(() => {
			console.log(`[tanstack PoC] change → rendered in ${Math.round(performance.now() - t)} ms`);
		});
	});
};

watch(dialogHash, (h) => { attach(h); }, { immediate: true });
onBeforeUnmount(() => { if (unsubscribe) unsubscribe(); });

const handleSendMessage = (text) => {
	if (!text.trim() || !peerHash.value) return;
	const messageId = 'dmsg_' + uuidv7();
	pendingSends.set(messageId, performance.now());
	$dialogs.sendMessage(peerHash.value, text.trim(), null, messageId, Math.floor(Date.now() / 1000));
};
</script>
