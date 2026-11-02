<template>
	<div class="_menu">
		<!-- The sections: a dark rail on a desktop, tabs at the bottom on a phone. -->
		<nav class="_rail" aria-label="Sections">
			<div class="_logo" v-if="!$breakpoint.lt('md')"><i class="_icon_logo"></i></div>

			<router-link v-for="tab in tabs" :key="tab.key" :to="tab.to" class="_tab" :class="[`_${tab.key}`, { _active: menu === tab.key }]"
				:aria-label="tab.label" :aria-current="menu === tab.key ? 'page' : undefined" :title="tab.label">
				<i :class="menu === tab.key ? `_icon_${tab.icon}_filled` : `_icon_${tab.icon}`"></i>
				<span>{{ tab.label }}</span>
			</router-link>
		</nav>

		<div class="_sub">
			<h1 class="_title" v-if="menu">{{ menuRegistry[menu].title }}</h1>
			<div class="_list" v-if="component">
				<component :is="component"></component>
			</div>
			<!-- Screen 11: the queue follows the user out of the dialog. -->
			<TransferDock v-if="menu === 'chats'" />
		</div>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._menu {
	display: flex;
	flex-direction: column-reverse;
	width: 100%;
	height: 100%;
	background: var(--color-surface);

	@include media-breakpoint-up(md) {
		flex-direction: row;
		width: unset;
	}
}

._rail {
	display: flex;
	flex-shrink: 0;
	background: var(--color-bg);
	border-top: 1px solid var(--color-border);
	padding-bottom: env(safe-area-inset-bottom);

	@include media-breakpoint-up(md) {
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		width: 72px;
		padding: var(--space-4) 0;
		border-top: 0;
		background: var(--color-ink);
	}
}

._logo {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	margin-bottom: var(--space-4);
	border-radius: var(--radius-input);
	background: var(--gradient-brand);

	i { width: 28px; height: 28px; background-color: var(--color-text-on-dark); }
}

._tab {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: var(--space-2) 0 var(--space-1);
	color: var(--color-text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-xs);
	text-decoration: none;

	i { width: 24px; height: 24px; background-color: currentColor; }

	&._active { color: var(--color-accent); }
	&:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }

	@include media-breakpoint-up(md) {
		flex: 0 0 auto;
		justify-content: center;
		width: 48px;
		height: 48px;
		padding: 0;
		border-radius: var(--radius-input);
		color: rgba(255, 255, 255, 0.72);

		span { display: none; }

		&:hover { background: rgba(255, 255, 255, 0.08); color: var(--color-text-on-dark); }
		&._active { background: rgba(255, 255, 255, 0.14); color: var(--color-text-on-dark); }

		// Account sits at the bottom of the rail
		&._account { margin-top: auto; }
	}
}

._sub {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	padding: var(--space-4) var(--space-4) 0;

	@include media-breakpoint-up(md) {
		width: 320px;
		flex: 0 0 320px;
		background: var(--color-bg);
		border-right: 1px solid var(--color-border);
		padding: var(--space-6) var(--space-3) 0;
	}
}

._title {
	margin: 0 0 var(--space-4);
	padding: 0 var(--space-1);
	font-size: var(--text-xl);
	line-height: var(--leading-xl);
	font-weight: var(--weight-semibold);
	color: var(--color-text);

	@include media-breakpoint-up(md) {
		padding: 0 var(--space-3);
	}
}

._list {
	flex: 1;
}
</style>

<script setup>
import TransferDock from '@/components/chat/TransferDock.vue';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { shallowRef, defineAsyncComponent, inject, watch, computed } from 'vue';
const $route = inject('$route');
const $breakpoint = useBreakpoint();

const tabs = [
	{ key: 'chats', label: 'Chats', icon: 'chats', to: '/chats' },
	{ key: 'contacts', label: 'Contacts', icon: 'contacts', to: '/contacts' },
	{ key: 'rooms', label: 'Rooms', icon: 'rooms', to: '/rooms' },
	{ key: 'account', label: 'Account', icon: 'profile', to: '/account' },
];

const menuRegistry = {
	contacts: { component: 'Menu_Contacts', title: 'Contacts' },
	users: { component: 'Menu_Users', title: 'Network Users' },
	rooms: { component: 'Menu_Rooms', title: 'Rooms' },
	chats: { component: 'Menu_Chats', title: 'Chats' },
	account: { component: 'Menu_Account', title: 'Account' },
};
const menu = computed(() => {
	const routeName = $route.name;
	if (!routeName) return null;
	if (routeName.includes('contact') || routeName === 'contacts') return 'contacts';
	if (routeName === 'users') return 'users';
	if (routeName.includes('room') || routeName === 'rooms') return 'rooms';
	if (routeName.includes('chat') || routeName === 'chats') return 'chats';
	if (routeName.includes('account') || routeName.includes('backup')) return 'account';
	return null;
});
const component = shallowRef(null);
watch(menu, (val) => {
	const registry = val && menuRegistry[val];
	if (!registry) { component.value = null; return; }
	component.value = defineAsyncComponent(() => import(`./views/${registry.component}.vue`));
}, { immediate: true });
</script>
