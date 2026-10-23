import { hkdfDerive } from './hkdf.js';
import { bytesToUuidV8 } from './slotId.js';

const GALLERY_UUID_SALT = 'buckitup/avatar-gallery-uuid/v1';
const GALLERY_UUID_INFO = 'gallery-uuid';
const GALLERY_KEY_SALT = 'buckitup/avatar-gallery-key/v1';
const GALLERY_KEY_INFO = 'gallery-key';

const requireSecret = (cryptSkey: Uint8Array): Uint8Array => {
	if (!(cryptSkey instanceof Uint8Array) || cryptSkey.length === 0) {
		throw new TypeError('the gallery derivation requires crypt_skey; is the vault unlocked?');
	}
	return cryptSkey;
};

export const deriveInitialGalleryUuid = (cryptSkey: Uint8Array): string =>
	bytesToUuidV8(hkdfDerive(requireSecret(cryptSkey), GALLERY_UUID_SALT, GALLERY_UUID_INFO, 16));

export const deriveInitialGalleryKey = (cryptSkey: Uint8Array): Uint8Array =>
	hkdfDerive(requireSecret(cryptSkey), GALLERY_KEY_SALT, GALLERY_KEY_INFO, 32);
