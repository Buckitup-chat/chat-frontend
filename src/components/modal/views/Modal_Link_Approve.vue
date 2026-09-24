<template>
	<div class="px-3 pt-3 pb-3">
		<div v-if="stage === 'input'">
			<div class="text-center text-secondary mb-2">
				On the new device choose <strong>Sync with other device</strong>, then scan its code here.
				Only continue with a code you are looking at on your own new device.
			</div>
			<div class="_qr_scanner mb-3" v-show="scanning">
				<video ref="videoEl"></video>
			</div>
			<button v-if="!scanning" class="btn btn-outline-dark w-100 mb-3" @click="startScan">Scan the code</button>
			<div class="text-center text-secondary small mb-1">or paste the code</div>
			<input type="text" class="form-control text-center mb-2" v-model="pasted" />
			<div v-if="inputError" class="text-danger small text-center mb-2">{{ inputError }}</div>
			<button class="btn btn-dark w-100" @click="begin(pasted)" :disabled="!pasted.trim()">Continue</button>
		</div>

		<div v-else-if="stage === 'connecting'" class="text-center text-secondary py-4">Reaching the new device…</div>

		<div v-else-if="stage === 'confirm'" class="text-center">
			<div class="text-secondary mb-2">Both devices show a code. Continue only if they match.</div>
			<div class="fw-bold display-5 my-3 font-monospace">{{ session.sas }}</div>
			<div class="text-secondary small mb-3">
				This sends the account <strong>{{ accountName }}</strong> — its keys included — to the new device.
			</div>
			<button class="btn btn-dark w-100 mb-2" @click="approve">The codes match — send</button>
			<button class="btn btn-outline-danger w-100" @click="reject">They differ</button>
		</div>

		<div v-else-if="stage === 'sending'" class="text-center text-secondary py-4">Sending… the new device will confirm.</div>

		<div v-else-if="stage === 'done'" class="text-center">
			<div class="text-success mb-3">The new device has your account.</div>
			<button class="btn btn-outline-dark w-100" @click="$mitt.emit('modal::close')">Close</button>
		</div>

		<div v-else-if="stage === 'error'" class="text-center">
			<div class="text-danger mb-3">{{ error }}</div>
			<button class="btn btn-outline-dark w-100" @click="restart">Start over</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._qr_scanner {
	display: flex;
	justify-content: center;
	border-radius: 1rem;
	overflow: hidden;
	video {
		width: 100%;
	}
}
</style>

<script setup>
// The device that has the account. It reads the invite, encapsulates to the
// key the relay delivers if — and only if — it hashes to the fingerprint the
// screen showed, and sends the backup once the person says so here. That tap
// is consent to send; the check against a planted account happens on the
// other screen (docs/device-link.md). This screen is only ever started by
// the person, from their account page: nothing opens it on their behalf.
import { ref, computed, inject } from 'vue';
import QrScanner from 'qr-scanner';
import { userPQStore } from '@/store/userPQ.store';
import { useLinkRoom } from '@/composables/useLinkRoom';
import {
	parseInvite, acceptOffer, sealPayload, signCommand, verifyCommand,
	encodeBytes, decodeBytes, DeviceLinkError,
} from '@/lib/pq/deviceLink';

const ABORTED = 'The new device stopped the link. Start again on both devices.';
const DROPPED = 'The connection dropped. Start again on both devices.';
/** How long to wait for the new device to announce itself before giving up. */
const OFFER_TIMEOUT_MS = 90_000;

const $userPQ = userPQStore();
const $mitt = inject('$mitt');

const { stage, error, session, join, send, fail, teardown, setCleanup } = useLinkRoom();
stage.value = 'input';

const videoEl = ref();
const scanning = ref(false);
const pasted = ref('');
const inputError = ref('');

const accountName = computed(() => $userPQ.currentUser?.name || 'this account');

let scanner = null;
let invite = null;
let offerTimer = null;

const stopScan = async () => {
	scanning.value = false;
	if (!scanner) return;
	const s = scanner;
	scanner = null;
	await s.stop();
	s.destroy();
};

setCleanup(() => {
	clearTimeout(offerTimer);
	offerTimer = null;
	invite = null;
	void stopScan();
});

const begin = async (text) => {
	// One attempt at a time: a scan decoding while the paste button is pressed
	// must not open a second room under the first one's handlers.
	if (stage.value !== 'input') return;
	let parsed;
	try {
		parsed = parseInvite(text);
	} catch {
		// A stray code in front of the camera is not a failure of the link;
		// say so where the person is and keep scanning.
		inputError.value = 'That is not a device-link code.';
		return;
	}
	invite = parsed;
	inputError.value = '';
	stage.value = 'connecting';
	await stopScan();
	const room = await join(invite.room, {
		onMessage,
		onClose: () => {
			// Once the new device has said done, the socket has nothing left to carry.
			if (stage.value !== 'done') fail(DROPPED);
		},
	});
	if (!room) return;
	// A stale QR names a room nobody is in any more; without this the screen
	// would say "Reaching…" for ever.
	offerTimer = setTimeout(() => {
		if (stage.value === 'connecting') fail('The new device did not answer. Make sure its code is still on screen, then start over.');
	}, OFFER_TIMEOUT_MS);
};

const onMessage = (msg) => {
	if (!msg || typeof msg !== 'object') return;
	if (!session.value) {
		if (msg.kind !== 'offer') return;
		try {
			session.value = acceptOffer(invite, decodeBytes(msg.kemPublicKey));
		} catch (e) {
			fail(e instanceof DeviceLinkError ? e.message : `Bad offer: ${e.message}`);
			return;
		}
		clearTimeout(offerTimer);
		send({ kind: 'accept', cipherText: encodeBytes(session.value.cipherText) });
		stage.value = 'confirm';
		return;
	}
	const command = verifyCommand(session.value, msg);
	if (!command) return;
	if (command.kind === 'done' && stage.value === 'sending') {
		stage.value = 'done';
		teardown();
	} else if (command.kind === 'abort') {
		fail(ABORTED);
	}
};

const approve = async () => {
	// Stage first: the buttons leave the DOM, so a second tap has nothing to hit.
	stage.value = 'sending';
	const current = session.value;
	try {
		const backup = await $userPQ.exportBackup();
		if (!backup) throw new DeviceLinkError('Not signed in.');
		const sealed = await sealPayload(current.key, JSON.stringify(backup));
		// The socket may have dropped during the export; fail() has already
		// spoken for that case and torn the session down.
		if (session.value !== current) return;
		send(signCommand(current, { kind: 'backup', sealed }));
	} catch (e) {
		console.error('device link send failed', e);
		if (session.value === current) send(signCommand(current, { kind: 'abort' }));
		fail(e instanceof DeviceLinkError ? e.message : 'The account could not be sent from this device.');
	}
};

const reject = () => {
	send(signCommand(session.value, { kind: 'abort' }));
	fail('The codes did not match. Nothing was sent — start again on both devices.');
};

const startScan = async () => {
	try {
		if (!(await QrScanner.hasCamera())) {
			inputError.value = 'No camera on this device — paste the code instead.';
			return;
		}
		scanner = new QrScanner(videoEl.value, (result) => begin(result.data), {
			returnDetailedScanResult: true,
			preferredCamera: 'environment',
			highlightScanRegion: true,
		});
		scanning.value = true;
		await scanner.start();
	} catch (e) {
		await stopScan();
		inputError.value = `Camera unavailable: ${e.message}`;
	}
};

const restart = async () => {
	teardown();
	pasted.value = '';
	inputError.value = '';
	stage.value = 'input';
};
</script>
