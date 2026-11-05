import { inject } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import escapeHtml from '@/utils/escapeHtml';
import errorMessage from '@/utils/errorMessage';

// The tail every restore shares — from a backup file, from shares: the account
// may already be on this device, then it is imported, then the app moves to
// it. The screens each carried a copy and the copies had drifted: one had
// stopped emitting account::created, which the login page listens to for its
// list of vaults.
export function useRestoreAccount() {
	const $userPQ = userPQStore();
	const $swalModal = inject('$swalModal');
	const $swal = inject('$swal');
	const $mitt = inject('$mitt');
	const $router = inject('$router');

	const offerSignIn = async (identity) => {
		const signIn = await $swalModal.value.open({
			id: 'confirm',
			title: 'This account is already on this device',
			content: `Account <strong>${escapeHtml(identity.name)}</strong> is already on this device, so there is nothing to restore. Sign in to it?`,
		});
		if (!signIn) return;
		try {
			await $userPQ.login(identity.user_hash);
		} catch (e) {
			console.error('[restore] sign-in failed', e);
			$swal.fire({ icon: 'error', title: 'Could not sign in', text: errorMessage(e) });
			return;
		}
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
	};

	/**
	 * Imports the backup and signs in to it. Resolves false when nothing was
	 * imported: the person declined to replace an account that is already
	 * here, or a passkey restore found its keys here already. `lock` goes to
	 * importBackup: a passkey restore passes the lock it prepared, and never
	 * replaces a vault, so it asks nothing about replacing one.
	 */
	const restore = async ({ identity, keys }, { lock } = {}) => {
		if (lock) {
			if (await $userPQ.hasLocalVault(identity.user_hash)) {
				await offerSignIn(identity);
				return false;
			}
		} else if ($userPQ.getMyUserByHash(identity.user_hash)) {
			const confirmed = await $swalModal.value.open({
				id: 'confirm',
				title: 'Account restore',
				// The name comes from the backup being restored - a file anyone could
				// have written - and the dialog renders markup.
				content: `Account <strong>${escapeHtml(identity.name)}</strong> already exists on this device. Replace it?`,
			});
			if (!confirmed) return false;
		}

		const result = await $userPQ.importBackup({ identity, keys }, lock ? { lock } : undefined);
		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		if (result.status === 'card-deferred') {
			$swal.fire({
				icon: 'info',
				title: 'Account restored',
				text: 'Its profile card could not be published right now. Sign in to the account to publish it.',
			});
			return true;
		}
		$router.replace({ name: 'account_info' });
		return true;
	};

	return { restore };
}
