import { createRouter, createWebHistory } from 'vue-router';
import { userPQStore } from '@/store/userPQ.store';

const routes = [
	{
		path: '/',
		name: 'home',
		redirect: '/login',
	},

	{
		path: '/login',
		name: 'login',
		component: () => import('../views/auth/Page_Login.vue'),
		meta: { name: 'Login' },
	},

	{
		path: '/chat/:address',
		name: 'chat',
		component: () => import('../views/chats/Page_Chat.vue'),
		meta: { auth: true, name: 'Chat' },
	},

	{
		path: '/room/:roomId',
		name: 'room',
		component: () => import('../views/rooms/Page_Room.vue'),
		meta: { auth: true, name: 'Room' },
	},

	{
		path: '/backup',
		name: 'backup',
		meta: { auth: true, name: 'Backup' },
		children: [
			{
				path: 'create',
				name: 'backup_create',
				component: () => import('../views/backup/Page_Backup_Create.vue'),
				meta: { auth: true, name: 'Create', sub: true },
			},
		],
	},
	{
		path: '/contact/:address',
		name: 'contact',
		component: () => import('../views/contacts/Page_Contact.vue'),
		meta: { auth: true, name: 'Contact' },
	},
	// {
	// 	path: '/users',
	// 	name: 'users',
	// 	component: () => import('../views/users/Users_List.vue'),
	// 	meta: { auth: true, name: 'Users' },
	// },
	{
		path: '/storage-api-client',
		name: 'storage_api_client',
		component: () => import('../views/storage/Page_Storage_Api.vue'),
		meta: { auth: true, name: 'Storage API Client' },
	},
	{
		path: '/account',
		name: 'account',
		meta: { auth: true, name: 'Account' },
		children: [
			{
				path: '',
				name: 'account_info',
				component: () => import('../views/account/Page_Account_Info.vue'),
				meta: { auth: true, name: 'Add Contact', sub: true },
			},
			{
				path: 'backups',
				name: 'account_backups',
				component: () => import('../views/backup/Page_Backup_Dashboard.vue'),
				meta: { auth: true, name: 'Backup Center', sub: true },
			},
			{
				path: 'admin',
				name: 'account_admin',
				component: () => import('../views/account/Page_Account_Admin.vue'),
				meta: { auth: true, name: 'Account Admin', sub: true },
			},

			{
				path: 'notifications',
				name: 'account_notifications',
				component: () => import('../views/account/Page_Account_Notifications.vue'),
				meta: { auth: true, name: 'Account Notifications', sub: true },
			},
			{
				path: 'settings',
				name: 'account_settings',
				component: () => import('../views/account/Page_Account_Settings.vue'),
				meta: { auth: true, name: 'Account Settings', sub: true },
			},
			{
				path: 'transactions',
				name: 'account_transactions',
				component: () => import('../views/account/Page_Account_Transactions.vue'),
				meta: { auth: true, name: 'Account Transactions', sub: true },
			},
		],
	},
	{
		path: '/:pathMatch(.*)*',
		redirect: '/',
	},
];

const router = createRouter({
	history: createWebHistory(),
	routes,
});

router.beforeEach(async (to, from, next) => {
	const $userPQ = userPQStore();

	if (to.meta.auth) {
		if ($userPQ.currentUser) {
			next();
		} else {
			next({ name: 'login' });
		}
	} else {
		if (!$userPQ.currentUser) {
			next();
		} else {
			next({ name: 'account_info' });
		}
	}
});

export default router;