<template>
	<ScreenHeader :title="source === 'address' ? 'Add node by address' : 'Add node'" back />
	<div class="cb-muted">A node keeps the node half of your backup. It should belong to someone who is not one of your guardians.</div>

	<div class="cb-tile pickable" :class="{ picked: source === 'contact' }" @click="source = 'contact'">
		<div class="cb-tile-head">
			<span class="cb-radio" :class="{ on: source === 'contact' }"></span>
			<div class="d-flex flex-column gap-1">
				<span class="cb-tile-title">A contact's BuckitUp device</span>
				<span class="cb-muted">A contact whose device runs as a node.</span>
			</div>
		</div>
	</div>
	<div class="cb-tile pickable" :class="{ picked: source === 'address' }" @click="source = 'address'">
		<div class="cb-tile-head">
			<span class="cb-radio" :class="{ on: source === 'address' }"></span>
			<div class="d-flex flex-column gap-1">
				<span class="cb-tile-title">By address</span>
				<span class="cb-muted">Type the https address of a node you know.</span>
			</div>
		</div>
	</div>

	<!-- 5.2: nodes whose verified descriptor names a contact as operator -->
	<template v-if="source === 'contact'">
		<div class="cb-section">Contacts with a node</div>
		<div v-if="!contactNodes.length" class="cb-small">
			{{ draft.state.nodesLoading ? 'Looking for nodes…' : 'None of your contacts runs a node this app knows. Add one by its address.' }}
		</div>
		<div class="cb-list">
			<div
				v-for="r in contactNodes"
				:key="r.id"
				class="cb-row"
				:class="{ pickable: r.selectable, picked: chosen === r.id, dim: !r.selectable }"
				data-test="contact-node"
				@click="r.selectable && (chosen = r.id)"
			>
				<ContactAvatar :hash="r.operator" :muted="!r.selectable" />
				<span class="cb-row-main">
					<span class="cb-row-name">{{ r.name }}</span>
					<span class="cb-row-sub">{{ r.guardian ? 'is your guardian' : r.host }}</span>
				</span>
				<span v-if="!r.guardian" :class="r.online ? 'cb-status-ok' : 'cb-status-warn'">{{ r.online ? 'online' : 'offline' }}</span>
			</div>
		</div>
		<div class="cb-actions">
			<button class="btn btn-dark w-100" :disabled="!chosenRow" @click="add(chosen)">{{ chosenRow ? `Add ${chosenRow.name}'s node` : 'Add node' }}</button>
		</div>
	</template>

	<!-- 5.3: by address -->
	<template v-else>
		<div class="d-flex gap-2">
			<input v-model="url" type="url" class="form-control" placeholder="https://" aria-label="Node address" :disabled="check === 'checking'" @keyup.enter="checkUrl" />
			<button class="btn btn-outline-dark" :disabled="!url.trim() || check === 'checking'" @click="checkUrl">Check</button>
		</div>
		<div v-if="check === 'checking'" class="cb-block" data-test="checking">
			<span><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Checking the address and the operator's signature…</span>
		</div>
		<div v-else-if="check?.state === 'refused'" class="cb-error" data-test="refused">{{ refusedText }}</div>
		<div v-else-if="check?.state === 'ready'" class="cb-block" data-test="ready">
			<span class="fw-semibold">{{ hostOf(check.node.descriptor.url) }}</span>
			<span class="cb-muted">
				Run by {{ readyName }} · signed ·
				<span :class="check.node.online ? 'cb-status-ok' : 'cb-status-warn'">{{ check.node.online ? 'online' : 'offline' }}</span>
			</span>
			<span v-if="readyRefusal" class="cb-field-error">{{ readyRefusal }}</span>
		</div>
		<div v-if="checkError" class="cb-error">{{ checkError }}</div>
		<div class="cb-actions">
			<button class="btn btn-dark w-100" :disabled="check?.state !== 'ready' || !!readyRefusal" @click="add(check.node.descriptor.id)">Add node</button>
		</div>
	</template>
</template>

<script setup>
import { computed, inject, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { guardianRunning, operatorOf, BUCKITUP } from '@/lib/recovery/nodeChoice';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import ContactAvatar from './ContactAvatar.vue';
import { DRAFT, NAV, hostOf, nodeCheckText, nodeOwnerName } from './backupFlow';

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const source = ref('contact');
const chosen = ref(null);
const pickedIds = computed(() => draft.nodes.value.map((n) => n.descriptor.id));

const contactNodes = computed(() =>
	store.nodes
		.filter((n) => operatorOf(n.descriptor.operator) !== BUCKITUP && $userPQ.contactsMap?.[n.descriptor.operator] && !pickedIds.value.includes(n.descriptor.id))
		.map((n) => {
			const guardian = !!guardianRunning(n, draft.guardianHashes.value);
			return {
				id: n.descriptor.id,
				operator: n.descriptor.operator,
				name: nodeOwnerName(n.descriptor, $userPQ),
				host: hostOf(n.descriptor.url),
				online: n.online,
				guardian,
				// A guardian's node would put both halves with one person; an offline one is not offered.
				selectable: n.online && !guardian,
			};
		}),
);
const chosenRow = computed(() => contactNodes.value.find((r) => r.id === chosen.value) ?? null);

const url = ref('');
/** null | 'checking' | NodeCheck */
const check = ref(null);
const checkError = ref(null);
const checkUrl = async () => {
	const typed = url.value.trim();
	if (!typed) return;
	check.value = 'checking';
	checkError.value = null;
	try {
		check.value = await store.addNodeUrl(typed);
	} catch (e) {
		check.value = null;
		checkError.value = errorMessage(e);
	}
};
const refusedText = computed(() => (check.value?.state === 'refused' ? nodeCheckText(check.value.reason) : ''));
const readyName = computed(() => (check.value?.state === 'ready' ? nodeOwnerName(check.value.node.descriptor, $userPQ) : ''));
const readyRefusal = computed(() => {
	if (check.value?.state !== 'ready') return null;
	if (guardianRunning(check.value.node, draft.guardianHashes.value)) return `${readyName.value} is a guardian. One person would hold both halves.`;
	if (!check.value.node.online) return 'The node is offline. Add it when it answers again.';
	if (pickedIds.value.includes(check.value.node.descriptor.id)) return 'This node is already picked.';
	return null;
});

const add = (id) => {
	if (!id) return;
	draft.pinNodes();
	draft.setNodes([...draft.state.nodeIds.filter((x) => x !== id), id]);
	nav.back();
};
</script>
