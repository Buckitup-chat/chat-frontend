// Earlier builds stored each upload's file key in localStorage, in plaintext
// and never read again (bkp:pending-upload:<fileId>). Anyone reading the
// profile's storage could decrypt those files, so what is left is removed.
const PREFIX = 'bkp:pending-upload:';

export function forgetPlaintextUploadKeys(): void {
	try {
		for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
	} catch {
		/* storage unavailable or blocked: nothing to clear */
	}
}
