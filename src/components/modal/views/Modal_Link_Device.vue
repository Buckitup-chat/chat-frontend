<template>
	<div class="px-3 pt-3 pb-3">
		<div v-if="stage === 'waiting'" class="text-center">
			<div class="text-secondary mb-3">
				On the device that already has your account, open <strong>Account → Add a device</strong>
				and scan this code — or copy it and paste it there.
			</div>
			<div class="_qr_wrapper mb-3">
				<canvas ref="qrCanvas"></canvas>
			</div>
			<button class="btn btn-outline-dark w-100" @click="copyCode" :disabled="!invite">
				Copy code <i class="_icon_copy bg-black ms-2"></i>
			</button>
			<div class="text-secondary small mt-3">Waiting for the other device…</div>
		</div>

		<div v-else-if="stage === 'confirm'" class="text-center">
			<div class="text-secondary mb-2">Both devices show a code. Continue only if they match.</div>
			<div class="fw-bold display-5 my-3 font-monospace">{{ session.sas }}</div>
			<button class="btn btn-dark w-100 mb-2" @click="confirm">The codes match</button>
			<button class="btn btn-outline-danger w-100" @click="reject">They differ</button>
		</div>

		<div v-else-if="stage === 'awaiting'" class="text-center text-secondary py-4">
			Waiting for the other device to send…
		</div>

		<div v-else-if="stage === 'ready'" class="text-center">
			<div class="text-secondary mb-3">The account has arrived. Receiving it will ask for this device's passkey.</div>
			<button class="btn btn-dark w-100" @click="finish">Receive account</button>
		</div>

		<div v-else-if="stage === 'importing'" class="text-center text-secondary py-4">
			Receiving the account…
		</div>

		<div v-else-if="stage === 'error'" class="text-center">
			<div class="text-danger mb-3">{{ error }}</div>
			<button class="btn btn-outline-dark w-100" @click="start">Try again</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._qr_wrapper {
	display: flex;
	justify-content: center;
	canvas {
		width: 100% !important;
		max-width: 300px;
		height: auto !important;
	}
}
</style>

<script setup>
// The new device: it makes the offer and shows it as a QR code, then imports
// what the existing device sends once the person has confirmed the codes
// match on this screen. That confirmation is the one that protects against a
// planted account (docs/device-link.md). The import itself runs from a tap,
// never from the socket: creating the vault asks for a passkey, and WebKit
// refuses that outside a user gesture.
import { ref, watchEffect, onMounted, inject } from 'vue';
import QRCode from 'qrcode';
import { userPQStore } from '@/store/userPQ.store';
import { useLinkRoom } from '@/composables/useLinkRoom';
import copyToClipboard from '@/utils/copyToClipboard';
import {
	createOffer, encodeInvite, openOffer, unsealPayload, signCommand, verifyCommand,
	encodeBytes, decodeBytes, DeviceLinkError,
} from '@/lib/pq/deviceLink';

const QR_OPTIONS = { errorCorrectionLevel: 'M', width: 300, margin: 1 };
const ABORTED = 'The other device stopped the link. Start again on both devices.';
const DROPPED = 'The connection dropped. Start again on both devices.';

const $userPQ = userPQStore();
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');

const { stage, error, session, join, send, fail, teardown, setCleanup } = useLinkRoom();

const qrCanvas = ref();
const invite = ref('');

let offer = null;
let sealed = null;
let importing = false;

setCleanup(() => {
	// The KEM secret is the one thing on this device worth stealing until the
	// account arrives; it is zeroed as soon as the session exists, and here
	// in case it never did.
	offer?.kemSecretKey.fill(0);
	offer = null;
	sealed = null;
});

const start = async () => {
	teardown();
	stage.value = 'waiting';
	offer = createOffer();
	invite.value = encodeInvite(offer);
	const announce = () => send({ kind: 'offer', kemPublicKey: encodeBytes(offer.kemPublicKey) });
	const room = await join(offer.room, {
		onMessage,
		// The existing device may join after us: the room tells us, and we say it again.
		onJoin: announce,
		// Before a session exists, members come and go; after, the peer leaving
		// is the link ending - and only a signed abort says so, since a leave
		// carries no proof of who left.
		onClose: () => fail(DROPPED),
	});
	if (room) announce();
};

const onMessage = (msg) => {
	if (!msg || typeof msg !== 'object') return;
	if (!session.value) {
		if (msg.kind !== 'accept') return;
		try {
			session.value = openOffer(offer, decodeBytes(msg.cipherText));
		} catch (e) {
			fail(`The other device sent something this one cannot open: ${e.message}`);
			return;
		}
		// The secret has done its one job; the session key is all that is needed now.
		offer.kemSecretKey.fill(0);
		stage.value = 'confirm';
		return;
	}
	// From here on only the device that shares the session is heard, and the
	// relay's sender ids are not how that is decided.
	const command = verifyCommand(session.value, msg);
	if (!command) return;
	if (command.kind === 'backup') {
		sealed = command.sealed;
		if (stage.value === 'awaiting') stage.value = 'ready';
	} else if (command.kind === 'abort') {
		fail(ABORTED);
	}
};

const confirm = () => {
	stage.value = sealed ? 'ready' : 'awaiting';
};

const reject = () => {
	send(signCommand(session.value, { kind: 'abort' }));
	fail('The codes did not match. Nothing was transferred — start again on both devices.');
};

const finish = async () => {
	if (importing) return;
	importing = true;
	stage.value = 'importing';
	try {
		const backup = JSON.parse(await unsealPayload(session.value.key, sealed));
		if (!backup?.identity?.user_hash || !backup?.keys) throw new DeviceLinkError('The account data is incomplete.');

		// The same user_hash is the same signing key: there is nothing a second
		// copy could add, and importing one would only list the account twice.
		if ($userPQ.myLocalUsers?.some((u) => u.user_hash === backup.identity.user_hash)) {
			send(signCommand(session.value, { kind: 'abort' }));
			fail(`Account ${backup.identity.name} is already on this device — sign in to it.`);
			return;
		}

		await $userPQ.importBackup({ identity: backup.identity, keys: backup.keys });
		send(signCommand(session.value, { kind: 'done' }));
		teardown();
		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
		$swal.fire({ icon: 'success', title: 'Device linked', timer: 4000 });
	} catch (e) {
		console.error('device link import failed', e);
		if (session.value) send(signCommand(session.value, { kind: 'abort' }));
		fail(e instanceof DeviceLinkError ? e.message : 'The account could not be imported on this device.');
	} finally {
		importing = false;
	}
};

const copyCode = () => copyToClipboard(invite.value);

// One draw per (invite, canvas): the canvas is re-created with the stage, so
// the ref is part of the dependency, and post-flush means it exists by then.
watchEffect(() => {
	if (qrCanvas.value && invite.value) QRCode.toCanvas(qrCanvas.value, invite.value, QR_OPTIONS);
}, { flush: 'post' });

onMounted(start);
</script>
