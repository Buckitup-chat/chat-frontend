import { inject } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import escapeHtml from '@/utils/escapeHtml';

// The tail every restore shares — from a backup file, from shares: the account
// may already be on this device, then it is imported, then the app moves to
// it. The screens each carried a copy and the copies had drifted: one had
// stopped emitting account::created, which the login page listens to for its
// list of vaults.
export function useRestoreAccount() {
	const $userPQ = userPQStore();
	const $swalModal = inject('$swalModal');
	const $mitt = inject('$mitt');
	const $router = inject('$router');

	/**
	 * Imports the backup and signs in to it. Resolves false when the person
	 * declined to replace an account that is already here.
	 */
	const restore = async ({ identity, keys }) => {
		if ($userPQ.getMyUserByHash(identity.user_hash)) {
			const confirmed = await $swalModal.value.open({
				id: 'confirm',
				title: 'Account restore',
				// The name comes from the backup being restored - a file anyone could
				// have written - and the dialog renders markup.
				content: `Account <strong>${escapeHtml(identity.name)}</strong> already exists on this device. Replace it?`,
			});
			if (!confirmed) return false;
		}

		await $userPQ.importBackup({ identity, keys });
		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
		return true;
	};

	return { restore };
}
