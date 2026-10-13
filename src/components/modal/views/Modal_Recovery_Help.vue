<template>
	<div class="cb rh" data-test="recovery-help">
		<div class="cb-head">
			<div class="d-flex align-items-start gap-2">
				<span class="cb-title flex-grow-1">{{ title }}</span>
				<button type="button" class="cb-icon-btn" aria-label="Close" @click="close">
					<span class="_icon_times bg-dark"></span>
				</button>
			</div>
		</div>

		<!-- 1. Whom, and which piece -->
		<template v-if="step === 'start'">
			<div class="cb-muted">Only help someone you are talking to right now, on a call or in person, and are sure it is them.</div>
			<label class="cb-section" for="rh-code">Their recovery code</label>
			<input id="rh-code" v-model="code" class="form-control rh-mono" :disabled="byText" placeholder="u_…" data-test="help-code" />
			<label class="d-flex gap-2 align-items-center cb-small">
				<input v-model="byText" type="checkbox" data-test="help-by-text" /> They cannot receive messages in the app: we will use another messenger
			</label>
			<div class="cb-section">Whose piece</div>
			<div v-if="!store.helpable.length" class="cb-muted" data-test="help-none">You keep no piece that can be returned.</div>
			<div class="cb-list">
				<label v-for="h in store.helpable" :key="h.key" class="cb-row rh-row" :class="{ picked: picked === h.key }" data-test="help-holding">
					<input v-model="picked" type="radio" :value="h.key" class="d-none" />
					<ContactAvatar :hash="h.owner" small />
					<span class="cb-row-main">
						<span class="cb-row-name">{{ nameOf(h.owner) }}</span>
						<span class="cb-row-sub">Version {{ h.share.version }} · piece {{ h.share.shareIndex }}</span>
					</span>
				</label>
			</div>
			<div v-if="error" class="cb-error" data-test="help-error">{{ error }}</div>
			<button class="btn btn-dark" :disabled="busy || !picked || (!byText && !code.trim())" data-test="help-ask" @click="askThem">
				{{ byText ? 'Make the request' : 'Ask for their words' }}
			</button>
		</template>

		<!-- 1b. By text: the request to send, and their answer pasted back -->
		<template v-else-if="step === 'byText'">
			<div class="cb-muted">Send them this line by the messenger you are using:</div>
			<CopyField :value="requestText" wrap />
			<div class="cb-muted">Their app answers with a line starting with BUCKITUP-BINDING. Paste it here:</div>
			<textarea v-model="pasted" class="form-control rh-mono" rows="3" data-test="help-binding"></textarea>
			<div v-if="error" class="cb-error" data-test="help-error">{{ error }}</div>
			<button class="btn btn-dark" :disabled="!pasted.trim()" data-test="help-binding-read" @click="readTyped">Check it</button>
		</template>

		<!-- 2. Waiting for the binding in the dialog -->
		<template v-else-if="step === 'waiting'">
			<div class="cb-block">
				<div><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Waiting for their app to answer…</div>
				<div class="cb-small">Their app answers by itself within a minute, while it is open.</div>
			</div>
			<div v-if="error" class="cb-error" data-test="help-error">{{ error }}</div>
		</template>

		<!-- 3. The words -->
		<template v-else-if="step === 'compare'">
			<div class="cb-muted">Ask them to read the ten words on their screen. Approve only if every word matches, in this order.</div>
			<ol class="rh-words" data-test="help-words">
				<li v-for="(w, i) in checked.words" :key="i">{{ w }}</li>
			</ol>
			<div v-if="error" class="cb-error" data-test="help-error">{{ error }}</div>
			<div class="d-flex gap-2">
				<button class="btn btn-dark flex-fill" :disabled="busy" data-test="help-match" @click="approveIt">
					<span v-if="busy" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>They match — approve
				</button>
				<button class="btn btn-outline-danger flex-fill" :disabled="busy" data-test="help-differ" @click="differ">They differ</button>
			</div>
		</template>

		<template v-else-if="step === 'differ'">
			<div class="cb-error" data-test="help-differ-note">
				Nothing was approved. If the words differ, the code you were given or their answer was changed on the way — or it is not them. Start again only over a channel you trust.
			</div>
			<button class="btn btn-outline-dark" @click="close">Close</button>
		</template>

		<template v-else-if="step === 'approved'">
			<div class="cb-ok" data-test="help-approved">
				<div>You approved their new device.</div>
				<div v-if="session?.mode === 'text'">Once enough guardians approve and the waiting period is over, open Shares I keep and make the piece to send them.</div>
				<div v-else>Once enough guardians approve and the waiting period is over, your app sends your piece to them by itself, while it is open.</div>
			</div>
			<button class="btn btn-outline-dark" @click="close">Done</button>
		</template>

		<!-- 4. By text, in the window: the sealed piece and the digits -->
		<template v-else-if="step === 'seal'">
			<div v-if="sealed" class="d-flex flex-column gap-2" data-test="help-sealed">
				<div class="cb-muted">Send them this piece by the same messenger:</div>
				<CopyField :value="sealed.block" :shown="sealed.block.slice(0, 48) + '…'" />
				<div class="cb-muted">Then read them these six digits. Their app adds the piece only if they match.</div>
				<div class="rh-digits" data-test="help-digits">{{ sealed.digits }}</div>
				<button class="btn btn-dark" data-test="help-sent" @click="sent">I sent it and read the digits</button>
			</div>
			<div v-else-if="error" class="cb-error" data-test="help-error">{{ error }}</div>
			<div v-else class="cb-muted">Making the piece…</div>
		</template>
	</div>
</template>

<script setup>
// "Help someone recover" (plan § 7.5): the guardian names the person's
// temporary account and the piece, compares the ten words with them on a
// call, and approves. Opened on a help returned by hand whose gate is open,
// it makes the piece to send and the six digits to read out.
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRecoveryHelpStore } from '@/store/recoveryHelp.store';
import { userPQStore } from '@/store/userPQ.store';
import errorMessage from '@/utils/errorMessage';
import CopyField from '@/components/recovery/backup/CopyField.vue';
import ContactAvatar from '@/components/recovery/backup/ContactAvatar.vue';

const props = defineProps({ inputData: { type: Object, default: () => ({}) } });
const $mitt = inject('$mitt');
const store = useRecoveryHelpStore();
const $userPQ = userPQStore();

/** How often the dialog is read while waiting for their answer. */
const POLL_MS = 4000;

const step = ref('start');
const code = ref('');
const byText = ref(false);
const picked = ref(null);
const busy = ref(false);
const error = ref(null);
const session = ref(null);
const checked = ref(null);
const requestText = ref('');
const pasted = ref('');
const sealed = ref(null);

const TITLES = { start: 'Help someone recover', byText: 'Help by another messenger', waiting: 'Waiting for their answer', compare: 'Compare the words', seal: 'Send your piece' };
const title = computed(() => TITLES[step.value] ?? 'Help someone recover');
const nameOf = (h) => $userPQ.contactsMap?.[h]?.name || $userPQ.getUserByHash?.(h)?.name || `${h.slice(0, 10)}…`;
const close = () => $mitt.emit('modal::close');

let poll = null;
const stopPolling = () => {
	clearInterval(poll);
	poll = null;
};
const lookForAnswer = async () => {
	try {
		const found = await store.bindingOf(session.value);
		if (!found) return;
		stopPolling();
		checked.value = found;
		step.value = 'compare';
	} catch (e) {
		stopPolling();
		error.value = errorMessage(e);
	}
};

const askThem = async () => {
	busy.value = true;
	error.value = null;
	try {
		if (byText.value) {
			const out = await store.askByText({ holdingKey: picked.value });
			session.value = out.session;
			requestText.value = out.text;
			step.value = 'byText';
		} else {
			session.value = await store.ask({ peer: code.value, holdingKey: picked.value });
			step.value = 'waiting';
			poll = setInterval(lookForAnswer, POLL_MS);
			await lookForAnswer();
		}
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const readTyped = () => {
	error.value = null;
	try {
		checked.value = store.typedBinding(session.value, pasted.value);
		step.value = 'compare';
	} catch (e) {
		error.value = errorMessage(e);
	}
};

const approveIt = async () => {
	busy.value = true;
	error.value = null;
	try {
		session.value = await store.approve(session.value, checked.value);
		step.value = 'approved';
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const differ = async () => {
	step.value = 'differ';
	await store.cancel(session.value).catch((e) => console.warn('[recovery] the help could not be forgotten:', e));
};

const sent = async () => {
	await store.markSent(session.value);
	close();
};

onMounted(async () => {
	if (props.inputData?.sessionKey) {
		step.value = 'seal';
		await store.load();
		session.value = store.sessions[props.inputData.sessionKey] ?? null;
		try {
			if (!session.value) throw new Error('This help is no longer recorded.');
			sealed.value = await store.sealFor(session.value);
		} catch (e) {
			error.value = errorMessage(e);
		}
		return;
	}
	if (store.helpable.length === 1) picked.value = store.helpable[0].key;
});
onUnmounted(stopPolling);
</script>

<style lang="scss" scoped>
@import '@/components/recovery/backup/tokens';
@include cb-tokens;

.rh {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 16px;
	font-size: 14px;
}
.cb-title {
	font-weight: 700;
	font-size: 17px;
}
.cb-section {
	font-weight: 600;
	font-size: 13px;
}
.cb-block {
	background: #f2f2f2;
	border-radius: 14px;
	padding: 14px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.cb-icon-btn {
	border: 0;
	background: transparent;
	padding: 2px;
	line-height: 0;
	span {
		display: inline-block;
		width: 1.1rem;
		height: 1.1rem;
	}
}
.rh-mono {
	font-family: ui-monospace, monospace;
	font-size: 12px;
}
.rh-row {
	cursor: pointer;
	border: 1px solid transparent;
	&.picked {
		background: #f7e0f7;
		border-color: #8e2b77;
	}
}
.rh-words {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 4px 16px;
	margin: 0;
	padding-left: 1.5rem;
	font-family: ui-monospace, monospace;
	font-size: 16px;
	font-weight: 600;
}
.rh-digits {
	font-family: ui-monospace, monospace;
	font-size: 28px;
	font-weight: 700;
	letter-spacing: 4px;
	text-align: center;
}
</style>
