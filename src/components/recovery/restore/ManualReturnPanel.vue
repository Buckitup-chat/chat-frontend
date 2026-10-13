<template>
	<div class="cb-block" data-test="manual">
		<button class="btn btn-link p-0 text-start cb-section" type="button" data-test="manual-toggle" @click="shown = !shown">
			A guardian cannot reach you in the app?
		</button>
		<template v-if="shown">
			<div class="cb-muted">Paste here what your guardian sends you by another messenger: first a line starting with eip155, later a piece starting with BUCKITUP-SHARE.</div>
			<textarea v-model="pasted" class="form-control rs-paste" rows="3" data-test="manual-input" placeholder="Paste here"></textarea>
			<button class="btn btn-outline-dark" :disabled="!pasted.trim() || busy" data-test="manual-read" @click="read">Read</button>
			<div v-if="error" class="cb-field-error" data-test="manual-error">{{ error }}</div>

			<template v-if="answer">
				<div class="cb-muted">Send this back to your guardian, then read them the ten words above:</div>
				<CopyField :value="answer" :shown="answer.slice(0, 40) + '…'" />
			</template>
		</template>

		<!-- The digits: nothing is opened until the person says they match. -->
		<div v-if="store.pendingBlock" class="cb-warn" data-test="digits">
			<div>Ask {{ store.pendingBlock.name }} to read the six digits their app shows. Do they match these?</div>
			<div class="rs-digits" data-test="digits-value">{{ store.pendingBlock.digits }}</div>
			<div class="d-flex gap-2">
				<button class="btn btn-dark flex-fill" :disabled="busy" data-test="digits-match" @click="match">They match</button>
				<button class="btn btn-outline-danger flex-fill" :disabled="busy" data-test="digits-differ" @click="differ">They differ</button>
			</div>
		</div>
		<div v-if="notice" class="cb-small" data-test="manual-notice">{{ notice }}</div>
	</div>
</template>

<script setup>
// The way back by hand (pq_recovery_shares § Manual return): the guardian's
// request pasted in, the binding to send back as text, and a piece pasted in —
// opened only after the person says the six digits match.
import { ref } from 'vue';
import { useRecoveryRestoreStore } from '@/store/recoveryRestore.store';
import errorMessage from '@/utils/errorMessage';
import CopyField from '../backup/CopyField.vue';

const store = useRecoveryRestoreStore();
const shown = ref(false);
const pasted = ref('');
const busy = ref(false);
const error = ref(null);
const answer = ref(null);
const notice = ref(null);

const read = async () => {
	busy.value = true;
	error.value = null;
	notice.value = null;
	try {
		const text = pasted.value;
		if (/BUCKITUP-SHARE/.test(text)) {
			await store.readBlock(text);
		} else {
			answer.value = await store.typeRequest(text);
		}
		pasted.value = '';
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const match = async () => {
	busy.value = true;
	try {
		await store.confirmBlock();
		notice.value = 'The piece was added.';
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const differ = () => {
	store.rejectBlock();
	notice.value = 'Nothing was added. Ask your guardian to send the piece again, over a channel you trust.';
};
</script>

<style lang="scss" scoped>
@import '../backup/tokens';
@include cb-tokens;

.rs-paste {
	font-family: ui-monospace, monospace;
	font-size: 12px;
}
.rs-digits {
	font-family: ui-monospace, monospace;
	font-size: 28px;
	font-weight: 700;
	letter-spacing: 4px;
	text-align: center;
}
</style>
