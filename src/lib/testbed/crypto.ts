import { Buffer } from 'buffer';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodeAbiParameters } from 'viem';
import {
	shamirSplit, shamirCombine,
	eciesEncrypt, eciesDecrypt,
	deriveStealthKeysFromSignature,
	generateStealthAddress,
	generateStealthPrivateKey,
	getStealthAddressFromEphemeral,
} from './sdk';

export const GENERATE_STEALTH_ADDRESS_MESSAGE = `Sign this message to generate your secret keys.

Make sure to sign this message only on a trusted website!

Your PIN: {pin}`;

function toHex(buf: Buffer): `0x${string}` {
	return ('0x' + buf.toString('hex')) as `0x${string}`;
}

function fromHex(hex: string): Buffer {
	return Buffer.from(hex.replace('0x', ''), 'hex');
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
	const len = Math.max(a.length, b.length);
	const out = Buffer.alloc(len);
	for (let i = 0; i < len; i++) out[i] = (a[i] || 0) ^ (b[i] || 0);
	return out;
}

export function computeId(owner: `0x${string}`, label: string): `0x${string}` {
	return keccak256(encodeAbiParameters(
		[{ type: 'address' }, { type: 'string' }],
		[owner, label],
	));
}

export function splitPayload(payload: string): { masterA: string; masterB: string } {
	const payloadBuf = Buffer.from(payload, 'utf8');
	const masterA = Buffer.alloc(payloadBuf.length);
	window.crypto.getRandomValues(masterA);
	const masterB = xorBuffers(payloadBuf, masterA);
	return { masterA: toHex(masterA), masterB: toHex(masterB) };
}

export function recoverPayload(masterAHex: string, masterBHex: string): string {
	const result = xorBuffers(fromHex(masterAHex), fromHex(masterBHex));
	return result.toString('utf8');
}

export function generateNodeShares(secretHex: string, numShares: number, threshold: number): string[] {
	const secret = fromHex(secretHex);
	const shares = shamirSplit(secret, numShares, threshold);
	return shares.map(s => '0x' + Buffer.from(s).toString('hex'));
}

export function recoverNodeHalf(shares: string[]): string {
	const bufs = shares.map(s => fromHex(s));
	const result = shamirCombine(bufs);
	return '0x' + Buffer.from(result).toString('hex');
}

export async function generateHelperShares(
	secretHex: string,
	numShares: number,
	threshold: number,
	publicKeys: string[],
): Promise<string[]> {
	const plainShares = generateNodeShares(secretHex, numShares, threshold);
	return Promise.all(plainShares.map((share, i) => eciesEncrypt(share, publicKeys[i])));
}

export async function decryptHelperShare(encryptedShare: string, privateKey: string): Promise<string> {
	return eciesDecrypt(encryptedShare, privateKey);
}

export function recoverHelperHalf(shares: string[]): string {
	return recoverNodeHalf(shares);
}

export async function createGuardianKeypair(pin: string): Promise<{
	eoaPrivateKey: `0x${string}`;
	eoaAddress: `0x${string}`;
	spendingPrivateKey: `0x${string}`;
	spendingPublicKey: `0x${string}`;
}> {
	const eoaPrivateKey = generatePrivateKey();
	const account = privateKeyToAccount(eoaPrivateKey);
	const msg = GENERATE_STEALTH_ADDRESS_MESSAGE.replace('{pin}', pin);
	const sig = await account.signMessage({ message: msg });
	const keys = deriveStealthKeysFromSignature(sig);
	return {
		eoaPrivateKey,
		eoaAddress: account.address,
		spendingPrivateKey: keys.spendingPrivateKey,
		spendingPublicKey: privateKeyToAccount(keys.spendingPrivateKey).publicKey as `0x${string}`,
	};
}

export function generateOwnerAccount(): { privateKey: `0x${string}`; address: `0x${string}` } {
	const privateKey = generatePrivateKey();
	const address = privateKeyToAccount(privateKey).address;
	return { privateKey, address };
}

export {
	deriveStealthKeysFromSignature,
	generateStealthAddress,
	generateStealthPrivateKey,
	getStealthAddressFromEphemeral,
	shamirSplit,
	shamirCombine,
};
