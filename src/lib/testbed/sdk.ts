import { Buffer } from 'buffer';
import sss from 'shamirs-secret-sharing';
import EthCrypto from 'eth-crypto';
import * as secp from '@noble/secp256k1';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export function shamirSplit(secret: Uint8Array, numShares: number, threshold: number): Uint8Array[] {
	return sss.split(secret, { shares: numShares, threshold }) as Uint8Array[];
}

export function shamirCombine(shares: Uint8Array[]): Uint8Array {
	return sss.combine(shares) as Uint8Array;
}

export async function eciesEncrypt(plaintext: string, publicKey: string): Promise<string> {
	const encrypted = await EthCrypto.encryptWithPublicKey(
		publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey,
		plaintext,
	);
	return '0x' + EthCrypto.cipher.stringify(encrypted);
}

export async function eciesDecrypt(ciphertext: string, privateKey: string): Promise<string> {
	const encrypted = EthCrypto.cipher.parse(
		ciphertext.startsWith('0x') ? ciphertext.slice(2) : ciphertext,
	);
	return EthCrypto.decryptWithPrivateKey(
		privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey,
		encrypted,
	);
}

export function deriveStealthKeysFromSignature(sig: string): {
	spendingPrivateKey: `0x${string}`;
	viewingPrivateKey: `0x${string}`;
} {
	const raw = sig.replace('0x', '');
	const portion1 = raw.slice(0, 64);
	const portion2 = raw.slice(64, 128);
	return {
		spendingPrivateKey: keccak256(`0x${portion1}`),
		viewingPrivateKey: keccak256(`0x${portion2}`),
	};
}

export function generateStealthAddress(metaPublicKey: string): {
	address: `0x${string}`;
	publicKey: `0x${string}`;
	ephemeralPubKey: `0x${string}`;
} {
	const ephemeralPrivateKey = generatePrivateKey();
	const account = privateKeyToAccount(ephemeralPrivateKey);

	const sharedSecret = secp.getSharedSecret(
		ephemeralPrivateKey.replace('0x', ''),
		metaPublicKey.replace('0x', ''),
		false,
	);

	const hashedSharedSecret = keccak256(Buffer.from(sharedSecret.slice(1)));

	const rPubkeySpend = secp.ProjectivePoint.fromHex(metaPublicKey.replace('0x', ''));
	const stealthPubPoint = rPubkeySpend.multiply(BigInt(hashedSharedSecret));
	const stealthPubHex = stealthPubPoint.toHex(false);

	const stealthAddress = (
		'0x' + keccak256(Buffer.from(stealthPubHex, 'hex').slice(1)).slice(-40)
	) as `0x${string}`;

	return {
		address: stealthAddress,
		publicKey: ('0x' + stealthPubHex) as `0x${string}`,
		ephemeralPubKey: account.publicKey as `0x${string}`,
	};
}

export function generateStealthPrivateKey(
	metaPrivateKey: string,
	ephemeralPubKey: string,
): `0x${string}` {
	const sharedSecret = secp.getSharedSecret(
		metaPrivateKey.replace('0x', ''),
		ephemeralPubKey.replace('0x', ''),
		false,
	);

	const hashedSharedSecret = keccak256(Buffer.from(sharedSecret.slice(1)));

	const privBigInt = (BigInt(metaPrivateKey) * BigInt(hashedSharedSecret)) % secp.CURVE.n;

	return ('0x' + privBigInt.toString(16).padStart(64, '0')) as `0x${string}`;
}

export function getStealthAddressFromEphemeral(
	metaPrivateKey: string,
	ephemeralPubKey: string,
): `0x${string}` {
	const account = privateKeyToAccount(metaPrivateKey as `0x${string}`);

	const sharedSecret = secp.getSharedSecret(
		metaPrivateKey.replace('0x', ''),
		ephemeralPubKey.replace('0x', ''),
		false,
	);

	const hashedSharedSecret = keccak256(Buffer.from(sharedSecret.slice(1)));

	const rPubkeySpend = secp.ProjectivePoint.fromHex(
		account.publicKey.replace('0x', ''),
	);
	const stealthPubPoint = rPubkeySpend.multiply(BigInt(hashedSharedSecret));
	const stealthPubHex = stealthPubPoint.toHex(false);

	return (
		'0x' + keccak256(Buffer.from(stealthPubHex, 'hex').slice(1)).slice(-40)
	) as `0x${string}`;
}
