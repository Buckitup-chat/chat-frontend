// Every modal the app can open, and the single question of whether one can be
// opened at all.
//
// open() returns early on an unknown id, so an entry missing from this table is
// not merely hidden — no emitter can reach it. That makes the table the
// authority on reachability, and the thing a screen asks before rendering a
// button whose only job is to open one.

import { SANDBOX_SURFACES } from '@/config/sandbox';

// Splitting the wrap key by hand into shares is scaffolding for the community
// scheme, not a backup method (see config/sandbox). The gate belongs here rather
// than on the buttons, because any component can emit modal::open with an id:
// hiding an entry point would leave the modal itself reachable. The chunks do
// still ship — the loader in Modal_.vue is a glob over ./views — so this is a
// reachability gate, not a size one.
const SANDBOX_MODALS = {
	account_restore_shares: {
		header: true,
		component: 'Modal_Account_Restore_Shares',
		modalClass: 'modal-md',
		title: 'Restore account',
		icon: '_icon_shares',
	},
	account_backup_shamir_create: {
		header: true,
		component: 'Modal_Backup_Shamir_Create',
		modalClass: 'modal-md',
		title: 'Shamir Shares Backup',
		icon: '_icon_shares',
		modalStatic: true,
	},
};

export const modalRegistry = {
	add_contact: {
		header: true,
		modalStatic: true,
		component: 'Modal_AddContact',
		modalClass: 'modal-sm',
		title: 'Add contact',
		icon: '_icon_profile',
	},
	add_contact_handshake: {
		header: false,
		component: 'Modal_QrHandshake',
		modalClass: 'modal-md',
	},
	save_contact: {
		header: false,
		component: 'Modal_SaveContact',
		modalClass: 'modal-md',
	},

	account_create: {
		header: true,
		component: 'Modal_Account_Create',
		modalClass: 'modal-sm',
		title: 'Create account',
		icon: '_icon_profile',
	},

	account_backup: {
		header: true,
		component: 'Modal_Account_Backup',
		modalClass: 'modal-sm',
		title: 'Account Backup',
		icon: '_icon_backups',
	},

	// Device link: the existing device approves, the new device receives.
	account_link_approve: {
		header: true,
		component: 'Modal_Link_Approve',
		modalClass: 'modal-sm',
		title: 'Add a device',
		icon: '_icon_reload',
	},

	account_link_device: {
		header: true,
		component: 'Modal_Link_Device',
		modalClass: 'modal-sm',
		title: 'Link this device',
		icon: '_icon_reload',
	},

	account_activate: {
		header: false,
		component: 'Modal_Account_Activate',
		modalClass: 'modal-sm',
		title: 'Account Activation',
		icon: '_icon_profile',
		bodyClass: 'p-0',
	},

	account_backup_local: {
		header: true,
		component: 'Modal_Account_Backup_Local',
		modalClass: 'modal-sm',
		title: 'Local Backup',
		icon: '_icon_backups',
		modalStatic: true,
	},

	account_restore_local: {
		header: true,
		modalStatic: true,
		component: 'Modal_Account_Restore_Local',
		modalClass: 'modal-sm',
		title: 'Restore account',
		icon: '_icon_backups',
	},

	signin: {
		header: false,
		component: 'Modal_SignIn',
		modalClass: 'modal-md',
	},
	logout: {
		header: true,
		component: 'Modal_Logout',
		modalClass: 'modal-sm',
		title: 'Accounts',
		icon: '_icon_logout',
	},

	auth: {
		header: false,
		component: 'Modal_Auth',
		modalClass: 'modal-md',
	},

	contacts: {
		header: true,
		component: 'Modal_Contacts',
		modalClass: 'modal-md',
		title: 'Verified contacts',
		icon: '_icon_contacts',
	},
	...(SANDBOX_SURFACES ? SANDBOX_MODALS : {}),
};

/** Whether this modal exists in this build. */
export const isModalAvailable = (id) => Object.hasOwn(modalRegistry, id);
