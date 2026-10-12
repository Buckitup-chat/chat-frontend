<template>
	<ScreenHeader title="Nodes" back />

	<div class="cb-group">
		<div class="cb-setting">
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">Nodes needed</span>
				<span class="cb-small">of {{ picked.length }} picked · {{ plural(operatorCount, 'operator') }}</span>
			</div>
			<Stepper :model-value="draft.settings.value.nodeThreshold" :min="2" :max="Math.max(picked.length - 1, 2)" data-test="node-threshold" @update:model-value="(v) => (draft.state.nodeThreshold = v)" />
		</div>
	</div>

	<div v-if="draft.state.nodesLoading && !rows.length" class="cb-small">Looking for nodes…</div>
	<div class="cb-list">
		<div
			v-for="r in rows"
			:key="r.key"
			class="cb-row"
			:class="{ pickable: r.selectable, picked: r.picked, dim: !r.selectable }"
			:role="r.selectable ? 'checkbox' : null"
			:aria-checked="r.selectable ? r.picked : null"
			data-test="node-row"
			@click="r.selectable && toggle(r.id)"
		>
			<span v-if="r.selectable" class="cb-check" :class="{ on: r.picked }" data-test="node-check">
				<Check v-if="r.picked" />
			</span>
			<span v-else class="cb-check none"></span>
			<span class="cb-row-main">
				<span class="cb-row-name">{{ r.operator }}</span>
				<span class="cb-row-sub">{{ r.host }}</span>
			</span>
			<span :class="r.statusClass">{{ r.status }}</span>
		</div>
	</div>

	<div v-for="p in messages" :key="p.key" class="cb-warn" data-test="node-problem">
		<span>{{ p.text }}</span>
		<span v-if="p.removeNode || p.removeGuardian" class="d-flex flex-wrap gap-1 align-items-baseline">
			<button v-if="p.removeNode" class="cb-link" @click="toggle(p.removeNode)">Remove node</button>
			<template v-if="p.removeGuardian">
				<span>· or</span>
				<button class="cb-link" @click="draft.toggle(p.removeGuardian.userHash)">remove {{ p.removeGuardian.name }} as a guardian</button>
			</template>
		</span>
	</div>

	<div class="cb-actions">
		<div class="d-flex gap-2">
			<button class="btn btn-outline-dark flex-fill" @click="nav.go('addNode')">+ Add node</button>
			<button class="btn btn-dark flex-fill" @click="nav.back()">Done</button>
		</div>
	</div>
</template>

<script setup>
import { computed, inject } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { guardianRunning, operatorOf } from '@/lib/recovery/nodeChoice';
import { plural } from '@/lib/recovery/backupPlan';
import ScreenHeader from './ScreenHeader.vue';
import Stepper from './Stepper.vue';
import Check from './Check.vue';
import { DRAFT, NAV, guardianName, hostOf, nodeOwnerName, refusedNodeStatus } from './backupFlow';

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();
const $userPQ = userPQStore();

const picked = computed(() => draft.nodes.value);
const operatorCount = computed(() => new Set(picked.value.map((n) => operatorOf(n.descriptor.operator))).size);
const nameOf = (n) => nodeOwnerName(n.descriptor, $userPQ);

const rows = computed(() => {
	const ids = picked.value.map((n) => n.descriptor.id);
	const known = store.nodes.map((n) => {
		const guardian = guardianRunning(n, draft.guardianHashes.value);
		return {
			key: n.descriptor.id,
			id: n.descriptor.id,
			operator: nameOf(n),
			host: hostOf(n.descriptor.url),
			picked: ids.includes(n.descriptor.id),
			// An offline node is not offered, as one that is not ready.
			selectable: n.online,
			status: !n.online ? 'offline' : guardian ? 'online · your guardian' : 'online',
			statusClass: n.online ? 'cb-status-ok' : 'cb-status-warn',
		};
	});
	const refused = Object.entries(store.refusedNodes ?? {}).map(([url, check]) => ({
		key: url,
		id: null,
		operator: hostOf(url),
		host: url,
		picked: false,
		selectable: false,
		status: refusedNodeStatus(check.reason),
		statusClass: 'cb-status-off',
	}));
	return [...known, ...refused];
});

const toggle = (id) => {
	draft.pinNodes();
	const ids = draft.state.nodeIds;
	draft.setNodes(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
};

const messages = computed(() =>
	draft.nodeIssues.value
		.map((p) => {
			if (p.kind === 'refused_node') {
				const node = picked.value.find((n) => n.descriptor.id === p.nodeId);
				if (!node) return null;
				const name = nameOf(node);
				if (p.reason === 'guardian_operator') {
					const who = guardianName(p.guardian, store.candidates, $userPQ);
					return {
						key: `g${p.nodeId}`,
						text: `${who} is a guardian and also runs this node. One person would hold both halves.`,
						removeNode: p.nodeId,
						removeGuardian: { userHash: p.guardian, name: who },
					};
				}
				return { key: `o${p.nodeId}`, text: `${name}'s node at ${hostOf(node.descriptor.url)} is offline.`, removeNode: p.nodeId };
			}
			if (p.kind === 'too_few_operators') {
				return {
					key: 'ops',
					text: `${plural(p.need - p.have, 'more node operator')} needed. The node half must be held by at least ${p.need} different people or organisations.`,
				};
			}
			if (p.kind === 'dominant_operator') {
				const theirs = picked.value.filter((n) => operatorOf(n.descriptor.operator) === p.operator);
				return { key: 'dom', text: `These nodes belong to too few people: ${theirs.length} of them are run by ${theirs[0] ? nameOf(theirs[0]) : 'one operator'}.` };
			}
			if (p.kind === 'threshold' && p.nodes < 2) return { key: 'thr', text: 'Pick at least 2 nodes.' };
			return null;
		})
		.filter(Boolean),
);
</script>
