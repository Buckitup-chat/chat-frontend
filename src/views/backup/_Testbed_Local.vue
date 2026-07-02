<template>
	<div>
		<div class="card mb-4 shadow-sm border-0">
			<div class="card-body">
				<div class="d-flex justify-content-between align-items-center mb-2">
					<h5 class="card-title fw-bold mb-0">Guardians</h5>
					<div>
						<button class="btn btn-sm btn-outline-success me-1" @click="$emit('add-guardian')">+ Add</button>
						<button class="btn btn-sm btn-outline-danger" @click="$emit('clear-guardians')" :disabled="guardians.length === 0">Clear</button>
					</div>
				</div>
				<p class="text-secondary small">Guardians hold ECIES-encrypted shares for the Helper plane.</p>
				<div v-if="guardians.length === 0" class="text-muted small">No guardians yet. Add at least 2.</div>
				<div v-for="g in guardians" :key="g.id" class="d-flex align-items-center border rounded p-2 mb-1 bg-light">
					<span class="fw-bold me-2" style="min-width:80px">{{ g.label }}</span>
					<code class="small text-muted flex-fill">{{ truncateAddr(g.stealthAddress) }}</code>
					<button class="btn btn-sm btn-outline-secondary ms-2" @click="$emit('remove-guardian', g.id)">&times;</button>
				</div>
			</div>
		</div>

		<div class="card mb-4 shadow-sm border-0">
			<div class="card-body">
				<h5 class="card-title fw-bold">1. Payload</h5>
				<p class="text-secondary small">Enter the secret to be split.</p>
				<textarea class="form-control mb-3" rows="3" :value="payloadInput" @input="$emit('update:payloadInput', $event.target.value)"
					placeholder='{"identity": "test", "keys": "..."}'></textarea>
				<button class="btn btn-dark w-100" @click="$emit('split')"
					:disabled="!payloadInput || guardians.length < 2 || splitting">
					{{ splitting ? 'Splitting…' : 'Split Secret (Vernam + Shamir + ECIES)' }}
				</button>
			</div>
		</div>

		<div v-if="splitDone" class="row mb-4">
			<div class="col-md-6 mb-3">
				<div class="card shadow-sm border-0 h-100">
					<div class="card-body">
						<h5 class="card-title fw-bold text-primary">Node Shares (A)</h5>
						<p class="text-secondary small">Infrastructure Plane — {{ nodeThreshold }} of {{ nodeShares.length }} required</p>
						<div v-for="(share, idx) in nodeShares" :key="'n' + idx" class="form-check mb-2">
							<input class="form-check-input" type="checkbox" :id="'node' + idx"
								:checked="selectedNodeShares.includes(share)"
								@change="toggleNodeShare(share, idx)">
							<label class="form-check-label w-100" :for="'node' + idx">
								<div class="small fw-bold">Share {{ idx + 1 }}</div>
								<div class="text-break small text-muted border p-1 rounded bg-light">{{ truncateHex(share) }}</div>
							</label>
						</div>
						<div class="text-end fw-bold mt-2"
							:class="{ 'text-success': selectedNodeShares.length >= nodeThreshold, 'text-danger': selectedNodeShares.length < nodeThreshold }">
							Selected: {{ selectedNodeShares.length }} / {{ nodeThreshold }}
						</div>
					</div>
				</div>
			</div>
			<div class="col-md-6 mb-3">
				<div class="card shadow-sm border-0 h-100">
					<div class="card-body">
						<h5 class="card-title fw-bold text-success">Helper Shares (B)</h5>
						<p class="text-secondary small">Each ECIES-encrypted to a guardian</p>
						<div v-for="(item, idx) in helperShareItems" :key="'h' + idx" class="form-check mb-2">
							<input class="form-check-input" type="checkbox" :id="'helper' + idx"
								:checked="selectedHelperIndices.includes(idx)"
								@change="toggleHelperIndex(idx)">
							<label class="form-check-label w-100" :for="'helper' + idx">
								<div class="small fw-bold">{{ item.label }}</div>
								<div class="text-break small text-muted border p-1 rounded bg-light">{{ truncateHex(item.encrypted) }}</div>
							</label>
						</div>
						<div class="text-end fw-bold mt-2"
							:class="{ 'text-success': selectedHelperIndices.length >= helperThreshold, 'text-danger': selectedHelperIndices.length < helperThreshold }">
							Selected: {{ selectedHelperIndices.length }} / {{ helperThreshold }}
						</div>
					</div>
				</div>
			</div>
		</div>

		<div v-if="splitDone" class="card shadow-sm border-0">
			<div class="card-body">
				<h5 class="card-title fw-bold">3. Reconstruct Payload</h5>
				<p class="text-secondary small">Shamir combine of both planes + final XOR.</p>
				<button class="btn btn-warning w-100 mb-3" @click="$emit('reconstruct')"
					:disabled="selectedNodeShares.length < nodeThreshold || selectedHelperIndices.length < helperThreshold || reconstructing">
					{{ reconstructing ? 'Reconstructing…' : 'Attempt Reconstruction' }}
				</button>

				<div v-if="reconstructDone" class="mt-3">
					<div v-if="match" class="alert alert-success">
						<strong>Success!</strong> Original payload recovered.
						<textarea class="form-control mt-2" rows="3" readonly :value="recoveredPayload"></textarea>
					</div>
					<div v-else class="alert alert-danger">
						<strong>Failed!</strong> {{ reconstructError }}
					</div>
				</div>
				<div v-if="reconstructDone && match" class="small text-muted border rounded p-2 mt-2">
					<div><strong>Master A</strong> {{ truncateHex(recoveredA) }}</div>
					<div><strong>Master B</strong> {{ truncateHex(recoveredB) }}</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
function truncateAddr(a) {
	if (!a || a.length < 16) return a;
	return a.slice(0, 10) + '…' + a.slice(-6);
}
function truncateHex(h) {
	if (!h) return '';
	const s = h.startsWith('0x') ? h.slice(2) : h;
	if (s.length <= 64) return '0x' + s;
	return '0x' + s.slice(0, 32) + '…' + s.slice(-32);
}

const props = defineProps({
	payloadInput: String, guardians: Array, nodeThreshold: Number, helperThreshold: Number,
	splitting: Boolean, splitDone: Boolean, nodeShares: Array, helperShareItems: Array,
	selectedNodeShares: Array, selectedHelperIndices: Array,
	reconstructing: Boolean, reconstructDone: Boolean, match: Boolean,
	recoveredPayload: String, reconstructError: String, recoveredA: String, recoveredB: String,
});

const emit = defineEmits([
	'update:payloadInput', 'split', 'reconstruct',
	'add-guardian', 'remove-guardian', 'clear-guardians',
	'update:selectedNodeShares', 'update:selectedHelperIndices',
]);

function toggleNodeShare(share, idx) {
	const current = [...props.selectedNodeShares];
	const i = current.indexOf(share);
	if (i >= 0) current.splice(i, 1);
	else current.push(share);
	emit('update:selectedNodeShares', current);
}

function toggleHelperIndex(idx) {
	const current = [...props.selectedHelperIndices];
	const i = current.indexOf(idx);
	if (i >= 0) current.splice(i, 1);
	else current.push(idx);
	emit('update:selectedHelperIndices', current);
}
</script>
