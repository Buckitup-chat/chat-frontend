// Device-link protocol. Design and threat model: docs/device-link.md.
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';
import { hkdfDerive } from './hkdf';
import { sealWithKey, assertSealed, openSealed, VaultEnvelopeError } from './vaultEnvelope';
import { toBase64, fromBase64, toBase64Url } from './signature';

export const DEVICE_LINK_SALT = 'buckitup/device-link/v1';

export class DeviceLinkError extends Error {}

/** The part of an offer that travels on the QR code / in the link. */
export interface LinkInvite {
	room: string;
	fingerprint: string;
}

/** What the new device holds while it waits: the invite plus the KEM key pair behind it. */
export interface LinkOffer extends LinkInvite {
	kemPublicKey: Uint8Array;
	kemSecretKey: Uint8Array;
}

/** What both sides end up with once the encapsulation has crossed. */
export interface LinkSession {
	key: Uint8Array;
	/** Authenticates the messages that follow; the relay's sender ids are client-supplied and prove nothing. */
	macKey: Uint8Array;
	sas: string;
}

export const fingerprintOf = (kemPublicKey: Uint8Array): string => toBase64Url(sha256(kemPublicKey));

export const createOffer = (): LinkOffer => {
	const { publicKey, secretKey } = ml_kem1024.keygen();
	return {
		room: toBase64Url(randomBytes(16)),
		fingerprint: fingerprintOf(publicKey),
		kemPublicKey: publicKey,
		kemSecretKey: secretKey,
	};
};

const INVITE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/**
 * The invite is a code, deliberately not a URL. A link that opened the app
 * would have to do something, and the only thing it could usefully do -
 * start the approve screen on the device that has the account - is exactly
 * what a crafted invite sent to a victim must not be able to do. The person
 * with the account starts the flow themselves, from their own account page.
 */
export const encodeInvite = (offer: LinkInvite): string => `${offer.room}.${offer.fingerprint}`;

/** The code as scanned or pasted; whitespace around it is forgiven. */
export const parseInvite = (text: string): LinkInvite => {
	const m = INVITE.exec(text.trim());
	if (!m) throw new DeviceLinkError('not a device-link invite');
	return { room: m[1], fingerprint: m[2] };
};

// Both derivations take the room, so a session key is bound to the room it
// was negotiated in and cannot be replayed into another.
const sessionFrom = (sharedSecret: Uint8Array, room: string): LinkSession => {
	const key = hkdfDerive(sharedSecret, DEVICE_LINK_SALT, `seal|${room}`, 32);
	const macKey = hkdfDerive(sharedSecret, DEVICE_LINK_SALT, `mac|${room}`, 32);
	const tag = hkdfDerive(sharedSecret, DEVICE_LINK_SALT, `sas|${room}`, 4);
	sharedSecret.fill(0);
	const n = ((tag[0] << 24) | (tag[1] << 16) | (tag[2] << 8) | tag[3]) >>> 0;
	return { key, macKey, sas: String(n % 1_000_000).padStart(6, '0') };
};

/**
 * Everything after the encapsulation is a command - backup, done, abort - and
 * the room is open to anyone with the code, whose channel id is whatever they
 * claim. So a command carries a MAC under the session, and a screen acts only
 * on commands that verify. The two messages before the session exist have
 * their own guards: an offer is checked against the fingerprint, and an
 * accept that did not come from the fingerprint's owner yields a session the
 * SAS will not confirm.
 */
export interface Command {
	kind: 'backup' | 'done' | 'abort';
	sealed?: string;
}

const commandBytes = (command: Command): Uint8Array =>
	new TextEncoder().encode(`${command.kind}|${command.sealed ?? ''}`);

export const signCommand = (session: LinkSession, command: Command): Command & { mac: string } => ({
	...command,
	mac: toBase64(hmac(sha3_256, session.macKey, commandBytes(command))),
});

/** The command, or null if it does not verify - which includes anything sent before a session existed. */
export const verifyCommand = (session: LinkSession, msg: unknown): Command | null => {
	if (!msg || typeof msg !== 'object') return null;
	const { kind, sealed, mac } = msg as Partial<Command & { mac: string }>;
	if (kind !== 'backup' && kind !== 'done' && kind !== 'abort') return null;
	if (typeof mac !== 'string') return null;
	const command: Command = sealed === undefined ? { kind } : { kind, sealed };
	const expected = hmac(sha3_256, session.macKey, commandBytes(command));
	let got: Uint8Array;
	try {
		got = fromBase64(mac);
	} catch {
		return null;
	}
	if (got.length !== expected.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= got[i] ^ expected[i];
	return diff === 0 ? command : null;
};

/**
 * The existing device, having received the new device's public key through
 * the relay: refuse anything but the key the QR code vouched for, then
 * encapsulate to it.
 */
export const acceptOffer = (
	invite: LinkInvite,
	kemPublicKey: Uint8Array,
): LinkSession & { cipherText: Uint8Array } => {
	if (fingerprintOf(kemPublicKey) !== invite.fingerprint) {
		throw new DeviceLinkError('the key received does not match the invite');
	}
	const { cipherText, sharedSecret } = ml_kem1024.encapsulate(kemPublicKey);
	return { cipherText, ...sessionFrom(sharedSecret, invite.room) };
};

/** The new device, having received the ciphertext: recover the session. */
export const openOffer = (offer: LinkOffer, cipherText: Uint8Array): LinkSession =>
	sessionFrom(ml_kem1024.decapsulate(cipherText, offer.kemSecretKey), offer.room);

/** The backup, sealed in the same form as a vault row (vaultEnvelope). */
export const sealPayload = (key: Uint8Array, json: string): Promise<string> => sealWithKey(key, json);

export const unsealPayload = async (key: Uint8Array, sealed: string): Promise<string> => {
	try {
		return await openSealed(key, assertSealed(sealed));
	} catch (e) {
		if (!(e instanceof VaultEnvelopeError)) throw e;
		// Structure and key are different diagnoses: a truncated frame is the
		// relay's fault and a retry; a key that does not open it means the two
		// devices did not derive the same session, which is what the SAS was
		// there to catch.
		throw new DeviceLinkError(
			e.reason === 'key' ? 'the payload does not open with this session' : 'not a sealed payload',
		);
	}
};

export { toBase64 as encodeBytes, fromBase64 as decodeBytes };
