<template>
	<!-- On a phone the profile card is the Identity item; a desktop lists it as a row of its own. -->
	<router-link v-if="$breakpoint.lt('md')" :to="{ name: 'account_info' }" class="_profile ui-card" @click="closeMenu()">
		<div class="_avatar">
			<img v-if="avatarSrc" :src="avatarSrc" alt="" />
			<Avatar v-else-if="me.user_hash" :name="me.user_hash" variant="bauhaus" />
		</div>
		<div class="_who">
			<div class="ui-title-sm _name">{{ me.name }}</div>
			<div class="ui-small ui-secondary ui-mono">{{ shortId }}</div>
		</div>
		<i class="_icon_back _chevron"></i>
	</router-link>

	<template v-for="group in groups" :key="group.label">
		<div class="ui-group-label">{{ group.label }}</div>
		<div class="_group" :class="{ 'ui-card': $breakpoint.lt('md') }">
			<UiRow v-for="item in group.items" :key="item.title" v-bind="item" :bare="!$breakpoint.lt('md')"
				:chevron="$breakpoint.lt('md')" :selected="!$breakpoint.lt('md') && isActive(item.to)"
				@click="closeMenu()" />
		</div>
	</template>

	<div class="_logout" :class="{ 'ui-card': $breakpoint.lt('md') }">
		<UiRow title="Log out" icon="logout" button :chevron="false" :bare="!$breakpoint.lt('md')"
			@select="$mitt.emit('modal::open', { id: 'logout' })" />
	</div>
</template>

<script setup>
import { computed, inject, onMounted } from 'vue';
import Avatar from 'vue-boring-avatars';
import UiRow from '@/components/ui/UiRow.vue';
import { useMenu } from '@/composables/useMenu';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useStorageStatusStore } from '@/store/storageStatus.store';
import { STORAGE_STATUS_TEXT } from '@/lib/storageStatus';
import { shortUserId } from '@/lib/shortUserId';

const $route = inject('$route');
const $dialogs = useDialogsStore();
const $mitt = inject('$mitt');
const $userPQ = userPQStore();
const $breakpoint = useBreakpoint();
const { close: closeMenu } = useMenu();
const storage = useStorageStatusStore();

// The storage page's status line in a few words; read each time the Account section opens.
onMounted(() => storage.refresh());

const me = computed(() => $userPQ.currentUser ?? {});
const avatarSrc = computed(() => (typeof me.value.avatar === 'string' ? me.value.avatar : ''));
const shortId = computed(() => shortUserId(me.value.user_hash));

const isActive = (to) => !!to && $route.name === to.name;

const groups = computed(() => [
	...($breakpoint.lt('md')
		? []
		: [{ label: 'You', items: [{ title: 'Identity', sub: 'Name, devices, ID', icon: 'profile', to: { name: 'account_info' } }] }]),
	{
		label: 'Security',
		items: [{ title: 'Backup Center', sub: 'Backup file and guardians', icon: 'backups', to: { name: 'account_backups' } }],
	},
	{
		label: 'App',
		items: [
			// The dot is what the dialogs list's sweep already found this session.
			{
				title: 'Checkpoints', sub: 'Changes in signed history', icon: 'checkpoint', to: { name: 'account_checkpoints' },
				dot: $dialogs.alertingPeers.size ? 'accent' : '',
			},
			{ title: 'Notifications', sub: 'Alerts about recovery attempts', icon: 'notifications', to: { name: 'account_notifications' } },
			{ title: 'Storage on this device', sub: STORAGE_STATUS_TEXT[storage.status]?.short ?? 'Checking…', icon: 'info', to: { name: 'account_storage' } },
			{ title: 'Install app', sub: 'On your phone or computer', icon: 'buckup_devices', to: { name: 'account_install' } },
		],
	},
]);
</script>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._profile {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-4);
	color: var(--color-text);
	text-decoration: none;
}

._avatar {
	flex-shrink: 0;
	width: 52px;
	height: 52px;
	border-radius: 50%;
	overflow: hidden;

	img,
	svg {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
}

._who {
	flex: 1;
	min-width: 0;
}

._name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

._chevron {
	width: 16px;
	height: 16px;
	transform: rotate(180deg);
	background-color: var(--color-text-muted);
}

._group {
	@include media-breakpoint-up(md) {
		:deep(.ui-row) { min-height: 56px; padding: var(--space-2) var(--space-3); }
		:deep(.ui-row + .ui-row::before) { display: none; }
	}
}

._logout {
	margin: var(--space-6) 0 var(--space-4);

	@include media-breakpoint-up(md) {
		margin-top: var(--space-4);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
		:deep(.ui-row) { min-height: 48px; padding: var(--space-2) var(--space-3); }
	}
}
</style>
