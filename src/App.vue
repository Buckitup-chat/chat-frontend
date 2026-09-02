<template>
	<div class="wrapper" v-if="$userPQ.currentUser">
		<template v-if="$userPQ.isInitialized">
			<Menu class="_menu" :class="{ _opened: $menuOpened }" />

			<div class="_menu_backdrop" :class="{ _opened: $menuOpened && $breakpoint.lt('md') }"
				@click="closeMenu()">
			</div>

			<div class="_main">
				<router-view v-slot="{ Component, route }">
					<component :is="Component" :key="route.path" />
				</router-view>
			</div>
		</template>
	</div>

	<div v-if="!$userPQ.currentUser" class="_login">
		<router-view v-slot="{ Component, route }">
			<component :is="Component" :key="route.path" />
		</router-view>
	</div>

	<Modal ref="$modal" />

	<Swal ref="$swalModal" />

	<Loader />
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._login {
	width: 100vw;
	/* full browser width */
	display: flex;
	/* use Flexbox */
	justify-content: center;
	/* horizontally center items */
	align-items: center;
	/* vertically center items */
}

.wrapper {
	display: flex;
	height: 100vh;
	height: 100dvh;
	flex-direction: row;
}

._menu {
	z-index: 10;
	white-space: nowrap;
	height: 100%;
	flex-shrink: 0;
	position: fixed;
	top: 0;
	left: 0;
	width: 360px;
	transform: translateX(-100%);
	transition: transform 0.3s ease;

	&._opened {
		transform: translateX(0);
	}

	@include media-breakpoint-up(md) {
		position: unset;
		transform: none;
	}

	box-shadow: 15px 0rem 1rem 0px rgb(0 0 0 / 12%);
	overflow: hidden;
}

._menu_backdrop {
	position: fixed;
	height: 100%;
	width: 100%;
	z-index: 9;
	background-color: rgba(0, 0, 0, 0.3);
	opacity: 0;
	transition: opacity 0.3s ease;
	pointer-events: none;

	&._opened {
		opacity: 1;
		pointer-events: all;
		cursor: pointer;
	}
}

/* 📌 Main Section */
._main {
	display: flex;
	flex-direction: row;
	overflow: hidden;
	height: 100%;
	width: 100%;
}

/* 📌 Mobile: Move `_menu` to Bottom */
@include media-breakpoint-up(md) {
	.wrapper {
		flex-direction: row;
	}

	._main {
		flex-grow: 1; // Takes remaining space
		height: 100%; // Adjust height to fit bottom menu
	}
}
</style>

<script setup>
import { web3Store } from '@/store/web3.store';

import { userPQStore } from '@/store/userPQ.store';

import { userStore } from '@/store/user.store';

import { useBreakpoint } from '@/composables/useBreakpoint';

import { useLoader } from '@/composables/useLoader';


import { useMenu } from '@/composables/useMenu';

import Loader from './components/Loader.vue';
import Menu from '@/views/menu/Menu_.vue';
import Modal from '@/components/modal/Modal_.vue';
import Swal from '@/components/swal/Swal_.vue';
import { ref, provide, watch, onMounted, inject, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const $socket = inject('$socket');
const $mitt = inject('$mitt');
const $user = userStore();
const $userPQ = userPQStore();
const $breakpoint = useBreakpoint();

const $encryptionManager = inject('$encryptionManager');
const $encryptionManagerPQ = inject('$encryptionManagerPQ');

// const $web3 = web3Store();
// const $swal = inject('$swal');
// const $isProd = inject('$isProd');

const $loader = useLoader();
watch(
	() => $userPQ.currentUser,
	(user) => {
		if (user && !$userPQ.isInitialized) $loader.show();
	},
	{ immediate: true }
);
watch(() => $userPQ.isInitialized, (val) => {
	if (val) $loader.hide();
});

const $appstate = ref({});
provide('$appstate', $appstate);

const $route = useRoute();
provide('$route', $route);

const $router = useRouter();
provide('$router', $router);

const { isOpen: $menuOpened, open: openMenu, close: closeMenu } = useMenu();

const $modal = ref();
provide('$modal', $modal);

const $swalModal = ref();
provide('$swalModal', $swalModal);

const timestamp = ref();
provide('$timestamp', timestamp);

watch(
	() => $breakpoint.current,
	() => {
		if ($breakpoint.gt('xs')) openMenu();
	},
);

	onMounted(() => {
		window.addEventListener('online', () => ($user.isOnline = navigator.onLine));
		window.addEventListener('offline', () => ($user.isOnline = navigator.onLine));
		setTimeout(function tick() {
			timestamp.value = Math.floor(Date.now().valueOf() / 1000);
			setTimeout(tick, 1000);
		}, 1000);

		$userPQ.initialize();
	});
</script>
