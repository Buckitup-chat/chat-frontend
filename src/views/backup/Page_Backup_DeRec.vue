<template>
	<div>
		<div class="mb-3">
			<div class="fw-bold fs-5 mb-2">DeRec Protocol Sandbox</div>
			<div class="text-secondary small mb-3">
				Test the <code>@derec-alliance/web</code> WASM package locally.
			</div>
		</div>

		<div class="_input_block mb-3">
			<div class="mb-3">
				<label class="form-label fw-bold">Private Secret</label>
				<textarea
					v-model="secretData"
					class="form-control"
					rows="3"
					placeholder="Enter some secret text to split"
				></textarea>
			</div>

			<div class="row gx-2 mb-3">
				<div class="col-6">
					<label class="form-label fw-bold">Helpers count</label>
					<input type="number" class="form-control" v-model="helpersCount" min="2" max="10" />
				</div>
				<div class="col-6">
					<label class="form-label fw-bold">Threshold</label>
					<input type="number" class="form-control" v-model="threshold" min="2" :max="helpersCount" />
				</div>
			</div>

			<div class="d-flex align-items-center">
				<button class="btn btn-dark px-4 py-2" @click="runDeRecTest" :disabled="processing">
					<span v-if="processing">Processing...</span>
					<span v-else>Split Secret</span>
				</button>
			</div>
		</div>

		<div v-if="error" class="alert alert-danger mb-3">
			{{ error }}
		</div>

		<div v-if="results" class="mb-3">
			<div class="_divider mb-3">Generated Shares (DeRecMessages)</div>

			<div class="_input_block mb-3" v-for="(shareBytes, channelId) in results" :key="channelId">
				<div class="d-flex justify-content-between mb-1">
					<span class="fw-bold">Helper Channel: {{ channelId }}</span>
					<span class="badge bg-secondary">{{ shareBytes.length }} bytes</span>
				</div>
				<textarea class="form-control text-monospace bg-light" rows="3" readonly :value="bytesToHex(shareBytes)"></textarea>
			</div>
			
			<div class="_divider mb-3">Recovery Test</div>
			<div class="d-flex align-items-center mb-3">
				<button class="btn btn-outline-dark me-2" @click="testRecovery" :disabled="processing">
					Test Recovery from Shares
				</button>
			</div>

			<div v-if="recoveredSecret" class="alert alert-success text-break">
				<strong>Recovered successfully:</strong><br/>
				{{ recoveredSecret }}
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { randomBytes } from '@noble/post-quantum/utils.js';
import { bytesToHex } from '@noble/hashes/utils';

// We import init and functions from @derec-alliance/web
import initWasm, { protect_secret, recover_from_share_responses } from '@derec-alliance/web';

const secretData = ref('My super secret seed phrase: apple banana orange...');
const helpersCount = ref(3);
const threshold = ref(2);
const processing = ref(false);
const error = ref(null);
const results = ref(null);
const recoveredSecret = ref(null);

let generatedChannels = [];
let secretIdBytes = null;
const secretVersion = 1;

onMounted(async () => {
	try {
		await initWasm();
		console.log('DeRec WASM initialized successfully');
	} catch (e) {
		console.error('Failed to init WASM:', e);
		error.value = 'Failed to load DeRec WASM module. See console.';
	}
});

const runDeRecTest = async () => {
	processing.value = true;
	error.value = null;
	results.value = null;
	recoveredSecret.value = null;
	
	try {
		// 1. Prepare secret ID (16 bytes)
		secretIdBytes = randomBytes(16);
		
		// 2. Prepare secret data bytes
		const secretBytes = new TextEncoder().encode(secretData.value);

		// 3. Mock pairing: generate random 32-byte shared_key for each helper
		generatedChannels = [];
		for (let i = 1; i <= helpersCount.value; i++) {
			generatedChannels.push({
				channel_id: BigInt(i),
				shared_key: randomBytes(32), // 32 bytes required for ChaCha20Poly1305
			});
		}

		console.log("Mock Channels:", generatedChannels);

		// 4. Run protect_secret
		// Arguments: secret_id, secret_data, channels, threshold, version, keep_list, description
		const output = protect_secret(
			secretIdBytes, 
			secretBytes, 
			generatedChannels, 
			threshold.value, 
			secretVersion, 
			null, 
			"Test Backup"
		);

		console.log("protect_secret output:", output);
		
		if (output && output.value) {
			results.value = output.value;
		} else {
			results.value = output; 
		}

	} catch (err) {
		console.error(err);
		error.value = err.toString();
	} finally {
		processing.value = false;
	}
};

const testRecovery = async () => {
	try {
		processing.value = true;
		
		const recoveryInputs = [];
		let count = 0;
		
		for (const channel of generatedChannels) {
			if (count >= threshold.value) break;
			
			const channelIdStr = channel.channel_id.toString();
			const responseBytes = results.value[channelIdStr] || results.value[Number(channel.channel_id)];
			
			if (responseBytes) {
				recoveryInputs.push({
					response_bytes: responseBytes,
					shared_key: channel.shared_key
				});
				count++;
			}
		}

		console.log(`Recovering with ${recoveryInputs.length} shares...`);

		const recoveredBytes = recover_from_share_responses(
			recoveryInputs,
			secretIdBytes,
			secretVersion
		);

		recoveredSecret.value = new TextDecoder().decode(recoveredBytes);

	} catch (err) {
		console.error(err);
		error.value = "Recovery failed: " + err.toString();
	} finally {
		processing.value = false;
	}
};

</script>

<style scoped>
.text-monospace {
	font-family: monospace;
	font-size: 0.85rem;
	word-break: break-all;
}
</style>