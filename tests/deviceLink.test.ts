// Device-link protocol (docs/device-link.md). Every negative case must be an
// error, not a silently different key.
import { describe, it, expect } from 'vitest';
import {
	createOffer, encodeInvite, parseInvite, acceptOffer, openOffer,
	sealPayload, unsealPayload, signCommand, verifyCommand, DeviceLinkError,
} from '@/lib/pq/deviceLink';

/** One full negotiation: the new device's offer, accepted by the existing one. */
const negotiate = () => {
	const offer = createOffer();
	const existing = acceptOffer(parseInvite(encodeInvite(offer)), offer.kemPublicKey);
	return { offer, existing };
};

describe('the invite', () => {
	it('round-trips as the code the QR carries, whitespace forgiven', () => {
		const offer = createOffer();
		const invite = { room: offer.room, fingerprint: offer.fingerprint };
		expect(parseInvite(encodeInvite(offer))).toEqual(invite);
		expect(parseInvite(`  ${encodeInvite(offer)}\n`)).toEqual(invite);
	});

	it('refuses anything else, a URL wrapping it included', () => {
		// A link is not an invite on purpose: nothing that opens the app may
		// start the sending side (docs/device-link.md).
		expect(() => parseInvite('hello')).toThrow(DeviceLinkError);
		expect(() => parseInvite(`https://app.example/login?link=${encodeInvite(createOffer())}`)).toThrow(DeviceLinkError);
		expect(() => parseInvite(encodeInvite(createOffer()).slice(1))).toThrow(DeviceLinkError);
	});

	it('names a fresh room every time', () => {
		expect(createOffer().room).not.toBe(createOffer().room);
	});
});

describe('the session', () => {
	it('gives both devices the same key and the same SAS', () => {
		const { offer, existing } = negotiate();
		const fresh = openOffer(offer, existing.cipherText);
		expect(fresh.key).toEqual(existing.key);
		expect(fresh.sas).toBe(existing.sas);
		expect(fresh.sas).toMatch(/^\d{6}$/);
	});

	it('refuses a public key the QR code did not vouch for', () => {
		// The relay swapped in its own key: the fingerprint on the screen
		// catches it before anything is encapsulated to it.
		const offer = createOffer();
		expect(() => acceptOffer(parseInvite(encodeInvite(offer)), createOffer().kemPublicKey))
			.toThrow(/does not match/);
	});

	it('does not let a session negotiated in one room open another', () => {
		const { offer, existing } = negotiate();
		const elsewhere = openOffer({ ...offer, room: createOffer().room }, existing.cipherText);
		expect(elsewhere.key).not.toEqual(existing.key);
	});
});

describe('the sealed backup', () => {
	const backup = JSON.stringify({ identity: { name: 'Alice' }, keys: { sign_skey: 'x'.repeat(64) } });

	it('opens with the session key and nothing else', async () => {
		const { offer, existing } = negotiate();
		const sealed = await sealPayload(existing.key, backup);
		expect(await unsealPayload(openOffer(offer, existing.cipherText).key, sealed)).toBe(backup);
		await expect(unsealPayload(negotiate().existing.key, sealed)).rejects.toThrow(/does not open/);
	});

	it('fails closed on a touched byte', async () => {
		const { existing } = negotiate();
		const sealed = await sealPayload(existing.key, backup);
		const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
		bytes[bytes.length - 1] ^= 1;
		await expect(unsealPayload(existing.key, btoa(String.fromCharCode(...bytes)))).rejects.toThrow(/does not open/);
	});

	it('tells a truncated frame apart from a wrong key', async () => {
		// A relay that drops bytes is a retry; a key mismatch is the SAS having
		// been wrong. Blaming the key for both would send the user to compare
		// codes that were fine.
		const key = new Uint8Array(32);
		await expect(unsealPayload(key, btoa('\x01abcd'))).rejects.toThrow(/not a sealed payload/);
		await expect(unsealPayload(key, btoa('\x09' + 'a'.repeat(40)))).rejects.toThrow(/not a sealed payload/);
		await expect(unsealPayload(key, '%%%')).rejects.toThrow(/not a sealed payload/);
	});
});

describe('commands after the session', () => {
	it('verify under the session they were signed in, and under no other', () => {
		const { offer, existing } = negotiate();
		const fresh = openOffer(offer, existing.cipherText);
		const signed = signCommand(existing, { kind: 'backup', sealed: 'blob' });
		expect(verifyCommand(fresh, signed)).toEqual({ kind: 'backup', sealed: 'blob' });
		// Anyone holding the room code can join it and claim any channel id;
		// what they cannot do is sign under a session they never derived.
		expect(verifyCommand(negotiate().existing, signed)).toBeNull();
	});

	it('refuses a command whose body was touched, or that carries no MAC at all', () => {
		const { offer, existing } = negotiate();
		const fresh = openOffer(offer, existing.cipherText);
		const signed = signCommand(existing, { kind: 'done' });
		expect(verifyCommand(fresh, { ...signed, kind: 'abort' })).toBeNull();
		expect(verifyCommand(fresh, { kind: 'done' })).toBeNull();
		expect(verifyCommand(fresh, { kind: 'done', mac: '%%' })).toBeNull();
		expect(verifyCommand(fresh, 'done')).toBeNull();
	});
});
