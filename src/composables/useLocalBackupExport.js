import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { encryptBackupFile } from '@/lib/backupCrypto';
import downloadFile from '@/utils/downloadFile';

// The password policy and the file naming live here rather than in each screen
// that offers the export. Two screens offer it (Security & Recovery, and the
// dashboard's modal), and while the rules were copied into both, the copies had
// already drifted: one lost the empty-password guard and threw a TypeError out
// of the Download handler — on the screen where a user saves their keys just
// before deleting the account.
const POLICY = [
	[(pw) => pw.length >= 10, 'Must be at least 10 characters long.'],
	[(pw) => /[A-Z]/.test(pw), 'Must contain an uppercase letter (A-Z).'],
	[(pw) => /[a-z]/.test(pw), 'Must contain a lowercase letter (a-z).'],
	[(pw) => /\d/.test(pw), 'Must contain a digit (0-9).'],
	[(pw) => /[!@#$%^&*(),.?":{}|<>]/.test(pw), 'Must contain a special character (e.g. !@#$%^&*).'],
];

const backupFileName = (rawName, encrypted) => {
	const now = new Date();
	const date = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, '0'),
		String(now.getDate()).padStart(2, '0'),
	].join('_');
	// Letters, digits, underscore and hyphen only: the rest of a display name
	// has no business in a filename the OS has to accept.
	const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
	return `backup_${date}_${safeName}${encrypted ? '_encrypted' : '_raw'}.bukitup`;
};

/**
 * The Local File backup: form state, password policy, and the write itself.
 *
 * `exportToFile()` resolves when the file has been handed to the browser and
 * the form has been reset. It throws if the vault cannot be read or the write
 * fails, so each screen keeps its own wording for the failure.
 */
export function useLocalBackupExport() {
	const $userPQ = userPQStore();

	const protect = ref(true);
	const showPassword = ref(true);
	const password = ref('');
	const dirty = ref(false);
	const processing = ref(false);

	watch(protect, (on) => {
		if (!on) {
			password.value = '';
			showPassword.value = true;
			dirty.value = false;
		}
	});

	watch(password, (val) => {
		if (!val) return;
		password.value = val.replaceAll(' ', '');
		if (val.length > 3) dirty.value = true;
	});

	const passwordErrors = computed(() => {
		if (!protect.value) return [];
		if (!password.value) return ['Password is required'];
		return POLICY.filter(([ok]) => !ok(password.value)).map(([, message]) => message);
	});

	/** False when the form is not ready or a write is already in flight. */
	const exportToFile = async () => {
		dirty.value = true;
		if (passwordErrors.value.length || processing.value) return false;

		// The derivation takes hundreds of milliseconds on a phone; without this
		// a second click would export, derive and download the whole thing twice.
		processing.value = true;
		try {
			const vault = await $userPQ.exportBackup();

			const json = JSON.stringify(vault, null, 2);
			// PBKDF2-SHA-256 600k → AES-256-GCM (src/lib/backupCrypto.ts). The
			// previous scheme derived its key by slicing the password bytes, so a
			// ten-character password left a two-byte key.
			const body = password.value ? await encryptBackupFile(json, password.value) : json;
			downloadFile(body, backupFileName($userPQ.currentUser?.name || 'account', !!password.value), 'text/plain');

			showPassword.value = true;
			password.value = '';
			dirty.value = false;
			return true;
		} finally {
			processing.value = false;
		}
	};

	return { protect, showPassword, password, dirty, processing, passwordErrors, exportToFile };
}
