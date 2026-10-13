// Every modal the app can open. open() returns early on an unknown id, so an
// entry missing from this table is not merely hidden — no emitter can reach it.

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

	// Recovery with friends: the recovering device's temporary account (plan § 7.5).
	account_recover_friends: {
		header: true,
		component: 'Modal_Recover_Friends',
		modalClass: 'modal-sm',
		title: 'Recover with friends',
		icon: '_icon_contacts',
	},

	// A guardian helping someone back in (plan § 7.5).
	recovery_help: {
		header: false,
		modalStatic: true,
		component: 'Modal_Recovery_Help',
		modalClass: 'modal-md',
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

	// Setting up a community backup and following its progress: one modal with
	// its own screens and header (Modal_Community_Backup).
	community_backup: {
		header: false,
		modalStatic: true,
		component: 'Modal_Community_Backup',
		modalClass: 'modal-md',
	},

	contacts: {
		header: true,
		component: 'Modal_Contacts',
		modalClass: 'modal-md',
		title: 'Verified contacts',
		icon: '_icon_contacts',
	},
};
