<template>
	<FullContentBlock>
		<template #header>
			<div class="fw-bold fs-5 py-1">Compartmented SSS Teststand</div>
		</template>

		<template #content>
			<div class="_full_width_block">

				<div class="alert alert-info d-flex justify-content-between align-items-center">
					<span>Vernam Cipher + Shamir + ECIES architecture testbed.</span>
					<div class="btn-group btn-group-sm">
						<button class="btn" :class="mode === 'local' ? 'btn-dark' : 'btn-outline-dark'" @click="mode = 'local'">Local</button>
						<button class="btn" :class="mode === 'network' ? 'btn-dark' : 'btn-outline-dark'" @click="mode = 'network'">Network</button>
					</div>
				</div>

				<!-- ==================== LOCAL MODE ==================== -->
				<template v-if="mode === 'local'">
					<LocalMode
						:payloadInput="payloadInput"
						:guardians="guardians"
						:nodeThreshold="nodeThreshold"
						:helperThreshold="helperThreshold"
						:splitting="splitting"
						:splitDone="splitDone"
						:nodeShares="nodeShares"
						:helperShareItems="helperShareItems"
						:selectedNodeShares="selectedNodeShares"
						:selectedHelperIndices="selectedHelperIndices"
						:reconstructing="reconstructing"
						:reconstructDone="reconstructDone"
						:match="match"
						:recoveredPayload="recoveredPayload"
						:reconstructError="reconstructError"
						:recoveredA="recoveredA"
						:recoveredB="recoveredB"
						@update:payloadInput="payloadInput = $event"
						@split="splitSecret"
						@reconstruct="reconstruct"
						@add-guardian="addGuardian"
						@remove-guardian="removeGuardian"
						@clear-guardians="clearAllGuardians"
						@update:selectedNodeShares="selectedNodeShares = $event"
						@update:selectedHelperIndices="selectedHelperIndices = $event"
					/>
				</template>

				<!-- ==================== NETWORK MODE ==================== -->
				<template v-if="mode === 'network'">
					<!-- Owner -->
					<div class="card mb-4 shadow-sm border-0">
						<div class="card-body">
							<div class="d-flex justify-content-between align-items-center mb-2">
								<h5 class="card-title fw-bold mb-0">1. Owner (Relayer pays gas)</h5>
								<button class="btn btn-sm btn-outline-secondary" @click="generateOwner" :disabled="!!owner">
									Generate EOA
								</button>
							</div>
							<div v-if="owner" class="border rounded p-2 bg-light">
								<div><strong>Address</strong> <code class="small">{{ owner.address }}</code></div>
								<div><strong>Balance</strong> <span class="small">{{ ownerBalance }}</span></div>
								<button class="btn btn-sm btn-outline-danger mt-2" @click="resetOwner">Clear</button>
							</div>
							<div v-else class="text-muted small">Generate a random EOA. The relayer will pay gas for all transactions.</div>
						</div>
					</div>

					<!-- Guardians -->
					<div class="card mb-4 shadow-sm border-0">
						<div class="card-body">
							<div class="d-flex justify-content-between align-items-center mb-2">
								<h5 class="card-title fw-bold mb-0">2. Guardians</h5>
								<div>
									<button class="btn btn-sm btn-outline-success me-1" @click="addGuardian" :disabled="busy">+ Add</button>
									<button class="btn btn-sm btn-outline-danger" @click="clearAllGuardians" :disabled="guardians.length === 0 || busy">Clear</button>
								</div>
							</div>
							<p class="text-secondary small">Each guardian must be registered on-chain before backup.</p>
							<div v-if="guardians.length === 0" class="text-muted small">No guardians. Add at least 2.</div>
							<div v-for="g in guardians" :key="g.id" class="d-flex align-items-center border rounded p-2 mb-1 bg-light">
								<span class="fw-bold me-2" style="min-width:80px">{{ g.label }}</span>
								<code class="small text-muted flex-fill">{{ truncateAddr(g.stealthAddress) }}</code>
								<span v-if="g.registered" class="badge bg-success me-2">Registered</span>
								<button v-else class="btn btn-sm btn-outline-info me-2" @click="registerGuardian(g)" :disabled="busy">Register</button>
								<button class="btn btn-sm btn-outline-secondary" @click="removeGuardian(g.id)" :disabled="busy">&times;</button>
							</div>
						</div>
					</div>

					<!-- Backup -->
					<div class="card mb-4 shadow-sm border-0">
						<div class="card-body">
							<h5 class="card-title fw-bold mb-2">3. Create Backup</h5>
							<p class="text-secondary small">Split payload into node + helper shares and deploy to Sepolia.</p>
							<textarea class="form-control mb-2" rows="2" v-model="payloadInput" placeholder='{"identity": "test"}'></textarea>
							<div class="row g-2 mb-2">
								<div class="col">
									<input class="form-control form-control-sm" v-model="backupLabel" placeholder="Label (e.g. 'my-backup')">
								</div>
								<div class="col-auto d-flex align-items-center">
									<label class="small me-2">Threshold: {{ friendThreshold }}</label>
									<input type="range" min="1" :max="guardians.length" v-model.number="friendThreshold" class="form-range" style="width:80px">
								</div>
							</div>
							<button class="btn btn-dark w-100" @click="createBackup"
								:disabled="!owner || guardians.length < 2 || busy || !backupLabel">
								{{ busy ? 'Creating…' : 'Deploy Backup to Sepolia' }}
							</button>
						</div>
					</div>

					<!-- Backups List -->
					<div v-if="networkBackups.length > 0" class="card mb-4 shadow-sm border-0">
						<div class="card-body">
							<h5 class="card-title fw-bold mb-2">4. Backups on Chain</h5>
							<div v-for="b in networkBackups" :key="b.id" class="border rounded p-2 mb-1 bg-light">
								<div class="d-flex justify-content-between align-items-center">
									<div>
										<strong>{{ b.label }}</strong>
										<code class="small ms-2 text-muted">{{ truncateAddr(b.id) }}</code>
									</div>
									<button class="btn btn-sm btn-warning" @click="runRecovery(b)" :disabled="busy">Recover</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Log Console -->
					<div class="card shadow-sm border-0">
						<div class="card-body">
							<div class="d-flex justify-content-between align-items-center mb-2">
								<h5 class="card-title fw-bold mb-0">Log</h5>
								<button class="btn btn-sm btn-outline-secondary" @click="clearLog">Clear</button>
							</div>
							<div ref="logContainer" class="border rounded bg-dark text-light p-2" style="max-height:300px;overflow-y:auto;font-size:0.75rem;font-family:monospace;">
								<div v-for="(entry, i) in logEntries" :key="i" :class="entryClass(entry)">{{ entry.text }}</div>
								<div v-if="logEntries.length === 0" class="text-muted">No activity yet.</div>
							</div>
						</div>
					</div>
				</template>

			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
._full_width_block { width: 100%; }
</style>

<script setup>
import { ref, watch, onMounted, nextTick } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import LocalMode from './_Testbed_Local.vue';

import { splitPayload, recoverPayload, generateNodeShares, recoverNodeHalf, generateHelperShares, decryptHelperShare, recoverHelperHalf, generateStealthPrivateKey, generateOwnerAccount } from '@/lib/testbed/crypto';
import { addGuardian as addGuard, removeGuardian as removeGuard, clearGuardians, loadGuardians } from '@/lib/testbed/guardians';
import { TESTBED } from '@/lib/testbed/config';
import { registerGuardianOnChain, createNetworkBackup, networkRunRecovery, loadBackupData, listBackupData, readBalance } from '@/lib/testbed/network';

// -- mode --
const mode = ref('local');

// -- local mode state --
const payloadInput = ref(JSON.stringify({ example: 'Sensitive key material for backup testing.' }, null, 2));
const guardians = ref([]);
const splitting = ref(false);
const splitDone = ref(false);
const nodeShares = ref([]);
const helperShareItems = ref([]);
const selectedNodeShares = ref([]);
const selectedHelperIndices = ref([]);
const reconstructing = ref(false);
const reconstructDone = ref(false);
const match = ref(false);
const recoveredPayload = ref('');
const reconstructError = ref('');
const recoveredA = ref('');
const recoveredB = ref('');

const nodeThreshold = TESTBED.NODE_THRESHOLD;
const helperThreshold = TESTBED.HELPER_THRESHOLD;
let storedMasterA = '';
let storedMasterB = '';

// -- network mode state --
const owner = ref(null);
const ownerBalance = ref('?');
const busy = ref(false);
const backupLabel = ref('testbed-' + Date.now().toString(36));
const friendThreshold = ref(2);
const logEntries = ref([]);
const logContainer = ref(null);
const networkBackups = ref([]);

// -- local mode functions --
onMounted(() => {
	guardians.value = loadGuardians();
	networkBackups.value = listBackupData();
});

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

async function addGuardian() {
	const g = await addGuard('G' + (guardians.value.length + 1));
	guardians.value = loadGuardians();
}

function removeGuardian(id) {
	removeGuard(id);
	guardians.value = loadGuardians();
}

function clearAllGuardians() {
	clearGuardians();
	guardians.value = [];
}

async function splitSecret() {
	splitting.value = true;
	splitDone.value = false;
	reconstructDone.value = false;
	try {
		const all = loadGuardians();
		if (all.length < 2) throw new Error('Need at least 2 guardians');

		const { masterA, masterB } = splitPayload(payloadInput.value);
		storedMasterA = masterA;
		storedMasterB = masterB;

		const nShares = generateNodeShares(masterA, TESTBED.NUM_NODES, TESTBED.NODE_THRESHOLD);
		nodeShares.value = nShares;

		const used = all.slice(0, TESTBED.NUM_HELPERS);
		const pubKeys = used.map(g => g.stealthPublicKey);
		const encryptedShares = await generateHelperShares(masterB, used.length, TESTBED.HELPER_THRESHOLD, pubKeys);

		helperShareItems.value = used.map((g, i) => ({
			guardianId: g.id, label: g.label, encrypted: encryptedShares[i],
			spendingPriv: g.spendingPrivateKey, ephemeralPub: g.ephemeralPubKey,
		}));

		selectedNodeShares.value = [];
		selectedHelperIndices.value = [];
		splitDone.value = true;
	} catch (e) {
		alert('Split error: ' + e.message);
	} finally {
		splitting.value = false;
	}
}

async function reconstruct() {
	reconstructing.value = true;
	reconstructDone.value = false;
	try {
		const mA = recoverNodeHalf(selectedNodeShares.value);
		recoveredA.value = mA;
		const selected = selectedHelperIndices.value.map(i => helperShareItems.value[i]);
		const decrypted = [];
		for (const item of selected) {
			const stealthPriv = generateStealthPrivateKey(item.spendingPriv, item.ephemeralPub);
			const plain = await decryptHelperShare(item.encrypted, stealthPriv);
			decrypted.push(plain);
		}
		const mB = recoverHelperHalf(decrypted);
		recoveredB.value = mB;
		const recovered = recoverPayload(mA, mB);
		recoveredPayload.value = recovered;
		match.value = recovered === payloadInput.value;
		if (!match.value) reconstructError.value = 'Payload mismatch — XOR produced different data.';
	} catch (e) {
		match.value = false;
		reconstructError.value = e.message;
	} finally {
		reconstructing.value = false;
		reconstructDone.value = true;
	}
}

// -- network mode functions --
function log(msg, type = 'info') {
	logEntries.value.push({ text: `[${new Date().toLocaleTimeString()}] ${msg}`, type });
	nextTick(() => {
		if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
	});
}

function entryClass(entry) {
	if (entry.type === 'success') return 'text-success';
	if (entry.type === 'error') return 'text-danger';
	if (entry.type === 'warn') return 'text-warning';
	return '';
}

function clearLog() {
	logEntries.value = [];
}

async function generateOwner() {
	owner.value = generateOwnerAccount();
	ownerBalance.value = 'checking…';
	try {
		ownerBalance.value = await readBalance(owner.value.address);
	} catch {
		ownerBalance.value = '?';
	}
	log(`Owner generated: ${owner.value.address}`, 'success');
}

function resetOwner() {
	owner.value = null;
	ownerBalance.value = '?';
}

async function registerGuardian(g) {
	busy.value = true;
	try {
		log(`Registering ${g.label} (${g.eoaAddress})…`);
		await registerGuardianOnChain(g, log);
		g.registered = true;
		// Update localStorage
		const list = loadGuardians();
		const idx = list.findIndex(x => x.id === g.id);
		if (idx >= 0) {
			list[idx].registered = true;
			localStorage.setItem('testbed.guardians', JSON.stringify(list));
		}
		log(`Guardian ${g.label} registered ✅`, 'success');
	} catch (e) {
		log(`Registration failed: ${e.message}`, 'error');
		alert('Registration failed: ' + e.message);
	} finally {
		busy.value = false;
	}
}

async function createBackup() {
	if (!owner.value) return;
	busy.value = true;
	try {
		log('Starting backup creation…');
		const all = loadGuardians();
		const registered = all.filter(g => g.registered);
		if (registered.length < 2) throw new Error('Need at least 2 registered guardians');

		const result = await createNetworkBackup(
			owner.value,
			payloadInput.value,
			backupLabel.value,
			registered.slice(0, TESTBED.NUM_HELPERS),
			friendThreshold.value,
			log,
		);
		log(`Backup created: ${result.id}`, 'success');
		networkBackups.value = listBackupData();
	} catch (e) {
		log(`Backup failed: ${e.message}`, 'error');
		alert('Backup failed: ' + e.message);
	} finally {
		busy.value = false;
	}
}

async function runRecovery(backup) {
	busy.value = true;
	try {
		log(`Starting recovery for ${backup.label} (${backup.id})…`);
		await networkRunRecovery(backup.id, log);
		log('Recovery complete ✅', 'success');
	} catch (e) {
		log(`Recovery failed: ${e.message}`, 'error');
		alert('Recovery failed: ' + e.message);
	} finally {
		busy.value = false;
	}
}
</script>
