<template>
	<div class="_hs">
		<div class="_hs_head">
			<button type="button" class="_hs_close" aria-label="Close" @click="closeModal()"><i class="_icon_times"></i></button>
			<div class="_hs_title" v-if="!contact">Add contact in person</div>
		</div>

		<!-- Stays after the result: the last code is on screen while the other phone may still be reading it. -->
		<QRScannerEngine
			ref="scannerEngineRef"
			v-if="hasCamera"
			v-show="!manual"
			@scanning="onScanning"
			@completed="onHandshakeCompleted"
		/>

		<div class="ui-card _hs_state" v-if="hasCamera === false && !manual">
			<div>No camera found</div>
			<div class="ui-small ui-secondary">Adding a contact in person needs a camera on this device, and access to it.</div>
		</div>

		<template v-if="manual">
			<div class="ui-notice _warning">
				<div class="_hs_strong">Verify before connecting</div>
				Adding someone by user ID skips the check in person. Make sure the ID came from them.
			</div>
			<div class="_hs_manual">
				<input class="form-control" placeholder="User ID (u_…)" type="text" v-model="userIdInput" />
				<button type="button" class="ui-btn" v-if="userIdInput" @click="addManually()">Add</button>
			</div>
			<button type="button" class="ui-btn _text _sm _hs_alt" v-if="hasCamera" @click="toggleScanner()">Add in person</button>
		</template>

		<button type="button" class="ui-btn _text _sm _hs_alt" v-if="!contact && !manual" @click="setManually()">Add manually</button>

		<!-- The handshake's result -->
		<template v-if="contact">
			<div class="_hs_result">
				<div class="_hs_avatar" :class="{ _ok: shownConfirmed }">
					{{ initials }}
					<span class="_hs_badge" v-if="shownConfirmed"><i class="_icon_verified"></i></span>
				</div>

				<template v-if="mismatch">
					<div class="_hs_heading">{{ isInContacts ? 'Contact not confirmed' : 'Contact not added' }}</div>
					<div class="ui-secondary">Different numbers mean the codes didn't come from these two phones. Start again, close together.</div>
				</template>
				<template v-else-if="alreadyConfirmed">
					<div class="_hs_heading">{{ contact.name }} is already confirmed</div>
					<div class="ui-secondary">Nothing changed.</div>
				</template>
				<template v-else-if="contact.confirmed">
					<div class="_hs_heading">Contact confirmed</div>
					<div class="ui-secondary">{{ isInContacts ? `${contact.name} is in your contacts.` : `${contact.name}'s phone proved their account.` }}</div>
				</template>
				<template v-else-if="contact.viaHandshake">
					<div class="_hs_heading _warning">Key verified in person; not yet confirmed</div>
					<div class="ui-secondary ui-small">{{ notConfirmedReason(contact) }}</div>
				</template>
				<template v-else>
					<div class="_hs_heading">{{ contact.name }}</div>
				</template>
			</div>

			<div class="_hs_sas" v-if="contact.sas && !mismatch && !alreadyConfirmed">
				<div class="ui-small ui-secondary">Check that {{ contact.name }}'s phone shows the same numbers</div>
				<div class="_hs_digits" data-test="contact-sas"><span v-for="(d, i) in contact.sas" :key="i" :class="{ _gap: i === 3 }">{{ d }}</span></div>
			</div>

			<div class="_hs_actions">
				<template v-if="mismatch">
					<button type="button" class="ui-btn _block" @click="toggleScanner()">Scan again</button>
				</template>
				<template v-else-if="alreadyConfirmed">
					<button type="button" class="ui-btn _block" @click="openChat()">Open chat</button>
				</template>
				<template v-else>
					<button type="button" class="ui-btn _block _lg" @click="addContact()">
						{{ contact.sas ? 'Numbers match · open chat' : isInContacts ? 'Open contact' : 'Save contact' }}
					</button>
					<button type="button" class="ui-btn _text _block _hs_danger" v-if="contact.sas" @click="mismatch = true">Numbers are different</button>
					<button type="button" class="ui-btn _text _block" v-else-if="contact.viaHandshake" @click="toggleScanner()">Scan again</button>
				</template>
			</div>
		</template>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

._hs {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
}

._hs_head {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-height: 32px;
}

._hs_close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	padding: 0;
	border: 0;
	background: none;
	cursor: pointer;

	i { width: 20px; height: 20px; background-color: var(--color-text); }
}

._hs_title {
	font-size: var(--text-lg);
	line-height: var(--leading-lg);
}

._hs_state {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-4);
}

._hs_strong { font-weight: var(--weight-semibold); margin-bottom: var(--space-1); }

._hs_manual {
	display: flex;
	gap: var(--space-2);
}

._hs_alt { align-self: center; }

._hs_result {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-2);
	text-align: center;
}

._hs_avatar {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 88px;
	height: 88px;
	margin-bottom: var(--space-3);
	border-radius: 50%;
	background: var(--color-surface);
	color: var(--color-text-secondary);
	font-size: var(--text-2xl);

	&._ok { background: #e3ebf7; color: #2c5d9e; }
}

._hs_badge {
	position: absolute;
	right: -2px;
	bottom: -2px;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border: 3px solid var(--color-bg);
	border-radius: 50%;
	background: var(--color-success-bg);

	i { width: 18px; height: 18px; background-color: var(--color-success); }
}

._hs_heading {
	font-size: var(--text-2xl);
	line-height: var(--leading-2xl);

	&._warning { font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--color-warning); }
}

._hs_sas {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-surface);
	text-align: center;
}

._hs_digits {
	display: flex;
	gap: var(--space-2);

	span {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 52px;
		border-radius: var(--radius-input);
		background: var(--color-bg);
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
	}

	._gap { margin-left: var(--space-4); }
}

._hs_actions {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin-top: var(--space-4);
}

._hs_danger { color: var(--color-danger); }
</style>

<script setup>
import { userPQStore } from '@/store/userPQ.store';

import { useMenu } from '@/composables/useMenu';

import { ref, inject, onMounted, computed } from 'vue';
import QRScannerEngine from '@/components/engines/QRScannerEngine.vue';
import { prefetchRelay } from '@/lib/data/turnCredentials';
import errorMessage from '@/utils/errorMessage';

const $userPQ = userPQStore();
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');
const { close: closeMenu } = useMenu();

const scannerEngineRef = ref(null);

const hasCamera = ref();
const contact = ref(null);
const manual = ref();
const scanning = ref(false);
const userIdInput = ref();
/** The person said the six digits differ: nothing is saved. */
const mismatch = ref(false);

defineProps({ inputData: { type: Object } });

onMounted(async () => {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		hasCamera.value = devices.some((device) => device.kind === 'videoinput');
	} catch (error) {
		console.error('Error checking camera availability:', error);
	}
	// The relay credentials are asked for here, one screen before the scanner
	// and only when there is a camera to scan with: a session takes what is
	// cached, or waits at most 1 s for them.
	if (hasCamera.value) void prefetchRelay();

	// Both screens read each other at once: the session starts with the modal.
	// Only into an empty screen: a result or the manual form already there is not wiped.
	if (hasCamera.value) setTimeout(() => { if (!contact.value && !manual.value && !scanning.value) void toggleScanner(); }, 100);
});

const onScanning = (isScanning) => {
	scanning.value = isScanning;
};

// The engine decides: `confirmed` comes with the card the handshake verified
// (its certified key is the one proved in person, and its identity signed the
// session over the channel). confirmContact checks that card again before
// anything is saved (docs/task-handshake-pq2.md §6).
const onHandshakeCompleted = (result) => {
	contact.value = { ...result, viaHandshake: true };
};

// Why a handshake ended verified in person only, by the engine's cause: the
// one place this is worded.
const NOT_CONFIRMED = {
	'no-channel': 'Check that both phones are online, or scan again on a shared Wi-Fi.',
	'no-address': 'This phone has no network to reach the other one. Check that both phones are online, or scan again on a shared Wi-Fi.',
	'no-card': 'Your profile card is not published yet, so the other phone cannot confirm you. Try again once you are online.',
	'no-signature': 'This phone could not sign the confirmation. Sign in again, then scan again.',
	'no-confirmation': 'The phones connected, but the other one sent no confirmation. Scan again.',
	refused: 'Their profile card does not certify the key their phone showed: this is not confirmed as their account.',
	deleted: 'This account is deleted: a deleted account cannot be confirmed.',
	'peer-unable': 'The other phone could not confirm its account: its profile card may not be published yet. Try again once it is online.',
};
const notConfirmedReason = (c) => NOT_CONFIRMED[c.cause] ?? NOT_CONFIRMED['no-channel'];

const onDeviceOnly = (saved) => !!saved?.status && saved.status !== 'synced';
const notSyncedFooter = (saved) => {
	if (!onDeviceOnly(saved)) return null;
	return saved.status === 'awaiting-approval'
		? 'It reaches the server once the device owner approves your account'
		: 'It reaches the server when this device can send it';
};


async function toggleScanner() {
	manual.value = false;
	contact.value = null;
	mismatch.value = false;
	userIdInput.value = null;
	
	if (scannerEngineRef.value) {
		await scannerEngineRef.value.toggleScanner();
	}
}

const stored = computed(() => (contact.value?.user_hash ? $userPQ.contactsMap[contact.value.user_hash] : null));
const isInContacts = computed(() => !!stored.value);
// Confirmed before, with the key the handshake proved again: there is nothing to save.
const alreadyConfirmed = computed(() => !!contact.value?.confirmed && !!stored.value?.confirmed
	&& stored.value.contact_pkey === contact.value.contact_pkey);
const shownConfirmed = computed(() => !mismatch.value && !!contact.value?.confirmed);
const initials = computed(() => (contact.value?.name || '?').trim().slice(0, 2).toUpperCase());

// "Numbers match · open chat" opens the chat; a contact without numbers opens its page, to be named.
const destination = () => ({ name: contact.value.sas ? 'chat' : 'contact', params: { address: contact.value.user_hash } });

const openChat = () => {
	closeMenu();
	$router.push({ name: 'chat', params: { address: contact.value.user_hash } });
	closeModal();
};

function closeModal() {
	$mitt.emit('modal::close');
}

const addContact = async () => {
	try {
		if ($userPQ.currentUserHash === contact.value.user_hash) {
			$swal.fire({
				icon: 'warning',
				title: 'It`s your own account',
				timer: 15000,
			});
			return;
		}

		// Only the handshake confirms: a contact added by id never carries `confirmed`.
		const confirmed = !!contact.value.confirmed;
		const notConfirmed = !!contact.value.viaHandshake && !confirmed;
		const notConfirmedFooter = notConfirmed ? notConfirmedReason(contact.value) : undefined;
		const sasText = confirmed && contact.value.sas ? `Code ${contact.value.sas}` : undefined;

		if (isInContacts.value) {
			// Scanned in person: that is what confirms it, with the card the
			// handshake verified.
			const saved = confirmed ? await $userPQ.confirmContact(contact.value.user_hash, contact.value.card, contact.value.contact_pkey) : null;
			$swal.fire({
				icon: notConfirmed ? 'warning' : 'success',
				title: onDeviceOnly(saved)
					? 'Contact confirmed on this device'
					: confirmed ? 'Contact confirmed' : notConfirmed ? 'Key verified in person; not yet confirmed' : 'Contact already in your list',
				text: sasText,
				footer: notSyncedFooter(saved) ?? notConfirmedFooter,
				timer: 15000,
			});
			manual.value = false;
			$router.push(destination());
			closeModal();
			return;
		}

		if (!contact.value.contact_pkey) {
			console.warn("Saving contact without contact_pkey. Encryption might not work.");
		}

		const fields = { name: contact.value.name, notes: '', hidden: false };
		const saved = confirmed
			? await $userPQ.confirmContact(contact.value.user_hash, contact.value.card, contact.value.contact_pkey, fields)
			: await $userPQ.saveContact(contact.value.user_hash, { ...fields, contact_pkey: contact.value.contact_pkey });

		$swal.fire({
			icon: notConfirmed ? 'warning' : 'success',
			title: onDeviceOnly(saved)
				? (confirmed ? 'Contact confirmed on this device' : 'Contact added on this device')
				: (confirmed ? 'Contact added and confirmed' : notConfirmed ? 'Key verified in person; not yet confirmed' : 'Contact added'),
			text: sasText,
			footer: notSyncedFooter(saved) ?? notConfirmedFooter ?? (contact.value.sas ? undefined : 'Now you can name it and make notes'),
			timer: 15000,
		});
		
		closeMenu();
		$router.push(destination());
		closeModal();
	} catch (error) {
		// Nothing was saved: say so, and stay here so it can be tried again.
		$swal.fire({
			icon: 'error',
			title: 'Contact not saved',
			text: errorMessage(error),
		});
	}
};

const setManually = async () => {
	if (scannerEngineRef.value) {
		scannerEngineRef.value.stopScan();
	}
	contact.value = null;
	manual.value = true;
	scanning.value = false;
	userIdInput.value = null;
};

const addManually = async () => {
	const userHash = userIdInput.value?.trim();
	if (!userHash || !userHash.startsWith('u_')) {
		$swal.fire({
			icon: 'warning',
			title: 'Invalid user ID format. Must start with u_',
			timer: 15000,
		});
		return;
	}

	const networkUser = $userPQ.allNetworkUsers.find(u => u.user_hash === userHash);

	contact.value = {
		user_hash: userHash,
		address: userHash,
		name: networkUser ? networkUser.name : 'Unknown User',
		contact_pkey: networkUser ? networkUser.contact_pkey : null
	};
	
	manual.value = false;
	addContact();
};
</script>