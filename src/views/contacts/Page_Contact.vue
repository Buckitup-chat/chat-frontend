<template>
	<FullContentBlock v-if="contact">
		<template #header>
			<div class="d-flex align-items-center justify-content-between w-100 pe-3">
				<div class="fw-bold fs-5">Contact</div>
				<button class="btn btn-dark rounded-pill ms-1 d-flex align-items-center justify-content-center p-2 px-3" @click="$mitt.emit('modal::open', { id: 'add_contact_handshake' })">
					<i class="_icon_plus bg-white"></i>
					<span class="ms-2">Add</span>
				</button>
			</div>
		</template>
		<template #content>
			<div class="_full_width_block">
				<Account_Info :account-in="contact" @update="updateContact" />

				<div class="text-danger text-center fw-bold mt-2" v-if="contact.hidden">Contact is hidden in your list of contacts</div>

				<div class="d-flex justify-content-center align-items-center mt-4 mb-3">
					<button type="button" class="btn btn-dark rounded-pill _action_btn" v-tooltip="'Chat with contact'" @click="goToChat()">
						<i class="_icon_chats bg-white"></i>
					</button>

					<button type="button" class="btn btn-dark rounded-pill _action_btn" v-tooltip="'Add contact to room'">
						<i class="_icon_rooms bg-white"></i>
					</button>

					<button
						v-if="isContact"
						type="button"
						class="btn btn-dark rounded-pill _action_btn"
						@click="toggleHidden()"
						v-tooltip="!contact.hidden ? 'Hide contact from list' : 'Restore (Unhide) contact in list'"
					>
						<i class="_icon_eye_cross bg-white" v-if="!contact.hidden"></i>
						<i class="_icon_eye bg-white" v-else></i>
					</button>

					<button
						v-else
						type="button"
						class="btn btn-dark rounded-pill _action_btn"
						@click="addToContacts()"
						v-tooltip="'Add to contacts'"
					>
						<i class="_icon_plus bg-white"></i>
					</button>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._full_width_block {
	max-width: 30rem;
	width: 100%;
}

._action_btn {
	padding: 0.8rem;
	@include media-breakpoint-up(sm) {
		padding: 1.2rem;
	}
	margin-left: 0.3rem;
	margin-right: 0.3rem;
	i {
		height: 1.5rem;
		width: 1.5rem;
	}
}
</style>

<script setup>
import { ref, onMounted, watch, inject, computed, nextTick } from 'vue';
import Account_Info from '@/components/Account_Info.vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import errorMessage from '@/utils/errorMessage';
import dayjs from 'dayjs';

const $userPQ = inject('$userPQ');
const $swal = inject('$swal');
const $route = inject('$route');
const $router = inject('$router');
const $swalModal = inject('$swalModal');
const $mitt = inject('$mitt');
const $enigma = inject('$enigma');

onMounted(async () => {
	if (!contact.value) {
		return $router.push({ name: 'account_info' });
	}
});

const goToChat = async () => {
	window.location.href = `https://buckitup.xyz/chat/${contact.value.user_hash}`;
};

const contact = computed(() => {
	let c = $userPQ.contacts.find((e) => e.user_hash === $route.params.address);
	if (!c) {
		c = $userPQ.getUserByHash($route.params.address);
	}
	return c;
});

const isContact = computed(() => {
	return !!$userPQ.contacts.find((e) => e.user_hash === $route.params.address);
});

const addToContacts = async () => {
	await $userPQ.saveContact(contact.value.user_hash, {
		name: contact.value.name || '',
		notes: '',
		hidden: false
	});
	$swal.fire({
		icon: 'success',
		title: 'Added to contacts',
		timer: 2000,
		showConfirmButton: false,
	});
};

const listedContacts = computed(() => {
	return $userPQ.contacts.filter((contact) => !contact.hidden);
});

async function updateContact(updatedContact) {
	await $userPQ.saveContact(contact.value.user_hash, updatedContact);
}

const toggleHidden = async () => {
	let hide;
	if (!contact.value.hidden) {
		if (!(await $swalModal.value.open({ id: 'delete_contact' }))) return;
		hide = true;
	}

	await $userPQ.saveContact(contact.value.user_hash, {
		...contact.value,
		hidden: !contact.value.hidden
	});

	if (hide) {
		if (listedContacts.value.length) {
			$router.push({ name: 'contact', params: { address: listedContacts.value[0].user_hash } });
		} else {
			if (window.history.length > 1) {
				$router.go(-1); // ✅ Go back if history exists
			} else {
				$router.push({ name: 'home' }); // ✅ Otherwise, go home
			}
		}
	}
};
</script>
