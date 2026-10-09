// The node plane, protocol v3 (chat repo: pq_recovery_services § Nodes, "The
// wire forms of v3"): a node's key-derived id, its signed descriptor, the
// signed deposit and release requests, a release encrypted to the requester,
// and the holding check. The node, the SDK and this client produce the same
// bytes; the golden vectors in tests/recoveryNodeClient.test.ts come from the
// SDK.
import { SigningKey, computeAddress } from 'ethers';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { sha3_256 } from '@noble/hashes/sha3';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { toBytes } from '@/lib/pq/signature';
import type { VerifiedCard } from '@/lib/pq/verifyCard';
import { nodeShareDigest } from 'backitup-secret-recovery-sdk/lib/constants/messages';
import { deploymentNamespace, type Deployment } from './deployments';
import { personalSignHex } from './evmSign';
import { NodeSetError, parseNodeUrl } from './nodeSet';

const strip0x = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex);

/** `n_` + lowercase hex of the first 16 bytes of SHA3-256 of the 33-byte compressed node key. */
export const nodeIdOf = (compressedPublicKey: string | Uint8Array): string => {
	const key = typeof compressedPublicKey === 'string' ? hexToBytes(strip0x(compressedPublicKey)) : compressedPublicKey;
	if (key.length !== 33) throw new Error('a node id is derived from the 33-byte compressed public key');
	return 'n_' + bytesToHex(sha3_256(key).slice(0, 16));
};

/* ------------------------------ descriptor ------------------------------ */

export interface NodeDescriptor {
	id: string;
	url: string;
	/** CAIP-2, e.g. `eip155:11155111`. */
	chain: string;
	/** Lowercase. */
	contract: string;
	/** The operator's `user_hash`. */
	operator: string;
	/** Unix seconds. */
	issued_at: number;
	node_pubkey: string;
	node_sig: string;
	/** ML-DSA-87 by the operator over the signed bytes, padded base64; null until endorsed. */
	operator_sig: string | null;
}

/** The bytes the node and its operator both sign. */
export const descriptorBytes = (d: Pick<NodeDescriptor, 'id' | 'url' | 'chain' | 'contract' | 'operator' | 'issued_at'>): Uint8Array =>
	utf8ToBytes(['buckitup/recovery-node/v1', d.id, d.url, d.chain, d.contract.toLowerCase(), d.operator, String(d.issued_at)].join('\n'));

export type DescriptorVerdict =
	| { ok: true; descriptor: NodeDescriptor }
	| {
			ok: false;
			reason: 'malformed' | 'wrong_url' | 'wrong_deployment' | 'bad_node_sig' | 'not_endorsed' | 'operator_unknown' | 'bad_operator_sig';
	  };

const isDescriptor = (d: unknown): d is NodeDescriptor => {
	if (!d || typeof d !== 'object') return false;
	const o = d as Record<string, unknown>;
	return (
		['id', 'url', 'chain', 'contract', 'operator', 'node_pubkey', 'node_sig'].every((k) => typeof o[k] === 'string') &&
		Number.isSafeInteger(o.issued_at) &&
		(o.operator_sig === null || typeof o.operator_sig === 'string')
	);
};

/** True when `node_pubkey` hashes to `id` and signs the descriptor bytes: `r || s`, 64 bytes, low-s. */
const signedByNode = (d: NodeDescriptor, bytes: Uint8Array): boolean => {
	try {
		const pub = hexToBytes(strip0x(d.node_pubkey));
		if (nodeIdOf(pub) !== d.id) return false;
		const sig = hexToBytes(strip0x(d.node_sig));
		// noble refuses a high s by default, so a malleated twin does not verify.
		return sig.length === 64 && secp.verify(sig, sha3_256(bytes), pub);
	} catch {
		return false;
	}
};

/**
 * Checks a descriptor fetched from `url` against the deployment a secret
 * lives on. `operatorCard` is the verified card of `descriptor.operator`, if
 * the client has it; without it the endorsement cannot be checked, and the
 * node is not offered.
 */
export const verifyDescriptor = (
	descriptor: unknown,
	expected: { url: string; deployment: Pick<Deployment, 'chainId' | 'secretRecovery'> },
	operatorCard: VerifiedCard | null | undefined,
): DescriptorVerdict => {
	if (!isDescriptor(descriptor)) return { ok: false, reason: 'malformed' };
	const d = descriptor;
	// Any node can serve another's descriptor: it is public and signed.
	if (d.url !== expected.url) return { ok: false, reason: 'wrong_url' };
	if (`${d.chain}:${d.contract}` !== deploymentNamespace(expected.deployment)) return { ok: false, reason: 'wrong_deployment' };
	const bytes = descriptorBytes(d);
	if (!signedByNode(d, bytes)) return { ok: false, reason: 'bad_node_sig' };
	if (!d.operator_sig) return { ok: false, reason: 'not_endorsed' };
	if (!operatorCard || operatorCard.userHash !== d.operator || operatorCard.deletedFlag) return { ok: false, reason: 'operator_unknown' };
	let endorsed = false;
	try {
		endorsed = ml_dsa87.verify(toBytes(d.operator_sig), bytes, toBytes(operatorCard.signPkeyB64));
	} catch {
		// a malformed signature or key endorses nothing
	}
	return endorsed ? { ok: true, descriptor: d } : { ok: false, reason: 'bad_operator_sig' };
};

/** Of two verified descriptors of one node, the one in force: the newer `issued_at`. */
export const newerDescriptor = (a: NodeDescriptor, b: NodeDescriptor): NodeDescriptor => (b.issued_at > a.issued_at ? b : a);

/**
 * A URL a node can be offered under: https, a name rather than a bare IP,
 * and not `.local` — the set travels with the shares and has to resolve for
 * years, from anywhere.
 */
export const isStableNodeUrl = (url: string): boolean => {
	let host: string;
	try {
		host = parseNodeUrl(url).hostname;
	} catch (e) {
		if (e instanceof NodeSetError) return false;
		throw e;
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return false;
	return host.includes('.') && !host.endsWith('.local') && !host.endsWith('.local.');
};

/* ------------------------------- messages ------------------------------- */

export interface DepositFields {
	nodeId: string;
	id: string;
	version: number;
	share: string;
	nonce: string;
	ts: number;
}

/** What an owner signs to deposit a node-half share at one node. */
export const depositMessage = (m: DepositFields): string =>
	[
		'Backitup node share deposit v3',
		`node: ${m.nodeId}`,
		`id: ${m.id.toLowerCase()}`,
		`version: ${m.version}`,
		`share: ${nodeShareDigest(m.share)}`,
		`nonce: ${m.nonce}`,
		`ts: ${m.ts}`,
	].join('\n');

export interface ReleaseFields {
	nodeId: string;
	id: string;
	recipient: string;
	nonce: string;
	ts: number;
}

/** What a recipient signs to ask one node for its node-half share. */
export const releaseMessage = (m: ReleaseFields): string =>
	[
		'Backitup node share request v3',
		`node: ${m.nodeId}`,
		`id: ${m.id.toLowerCase()}`,
		`recipient: ${m.recipient.toLowerCase()}`,
		`nonce: ${m.nonce}`,
		`ts: ${m.ts}`,
	].join('\n');

/* ---------------------------- release ECIES ---------------------------- */

// eccrypto's ECIES as the SDK serializes it: iv(16) || compressed ephemeral
// key (33) || mac(32) || ciphertext, with Px kept at 32 bytes.

const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Opens a release with the requester's private key; throws if the MAC does not hold. */
export const openRelease = async (shareEcies: string, privateKeyHex: string): Promise<string> => {
	const blob = hexToBytes(strip0x(shareEcies));
	if (blob.length < 16 + 33 + 32 + 16) throw new Error('release too short');
	const iv = blob.slice(0, 16);
	const ephemeral = secp.ProjectivePoint.fromHex(blob.slice(16, 49));
	const mac = blob.slice(49, 81);
	const ciphertext = blob.slice(81);
	const px = secp.getSharedSecret(hexToBytes(strip0x(privateKeyHex)), ephemeral.toRawBytes(true)).slice(1, 33);
	const hash = sha512(px);
	const expected = hmac(sha256, hash.slice(32), concatBytes(iv, ephemeral.toRawBytes(false), ciphertext));
	let diff = 0;
	for (let i = 0; i < 32; i++) diff |= expected[i] ^ mac[i];
	if (diff !== 0) throw new Error('release MAC does not hold');
	const key = await crypto.subtle.importKey('raw', asBuffer(hash.slice(0, 32)), { name: 'AES-CBC' }, false, ['decrypt']);
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: asBuffer(iv) }, key, asBuffer(ciphertext)));
};

/* --------------------------------- HTTP --------------------------------- */

/** A node answered, but not with what was asked; `status` 0 when it did not answer at all. */
export class NodeError extends Error {
	constructor(
		readonly url: string,
		readonly status: number,
		message: string,
	) {
		super(`node ${url}: ${message}`);
	}
}

export interface NodeClientOptions {
	fetch?: typeof fetch;
	/** Unix seconds; a node refuses a ts ahead of its clock, so the default trails ours a little. */
	now?: () => number;
	signal?: AbortSignal;
}

const call = async (url: string, path: string, init: Parameters<typeof fetch>[1], opts: NodeClientOptions): Promise<{ status: number; body: any }> => {
	let res: Response;
	try {
		res = await (opts.fetch ?? fetch)(url + path, { ...init, signal: opts.signal });
	} catch (e) {
		if ((e as Error)?.name === 'AbortError') throw e;
		throw new NodeError(url, 0, `does not answer: ${(e as Error).message}`);
	}
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		// a body that is not JSON reads as no body
	}
	return { status: res.status, body };
};

const post = (url: string, path: string, body: unknown, opts: NodeClientOptions) =>
	call(url, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, opts);

const failed = (url: string, r: { status: number; body: any }) => new NodeError(url, r.status, r.body?.error ?? `answered ${r.status}`);

const nowOf = (opts: NodeClientOptions) => (opts.now ?? (() => Math.floor(Date.now() / 1000) - 5))();
const newNonce = () => bytesToHex(randomBytes(16));

/** A node answers under the id it was asked by; another id is another node. */
const answeredAs = (node: NodeRef, r: { status: number; body: any }) => {
	if (r.body?.nodeId !== node.id) throw new NodeError(node.url, r.status, `answered as ${r.body?.nodeId}, not ${node.id}`);
};

/** The node's descriptor, unverified: `verifyDescriptor` decides what it is worth. */
export const fetchDescriptor = async (url: string, opts: NodeClientOptions = {}): Promise<unknown> => {
	const r = await call(url, '/info', {}, opts);
	if (r.status !== 200) throw failed(url, r);
	return r.body;
};

/** True when the node answers its health check. */
export const nodeIsUp = async (url: string, opts: NodeClientOptions = {}): Promise<boolean> => {
	try {
		return (await call(url, '/health', {}, opts)).status === 200;
	} catch (e) {
		if (e instanceof NodeError) return false;
		throw e;
	}
};

export interface NodeRef {
	id: string;
	url: string;
}

/**
 * Deposits `share` for secret `id` at `version`, signed by the owner's EVM
 * key. Returns whether the node staged it as a claim (the secret is not on
 * chain yet) rather than holding it.
 */
export const depositShare = async (
	node: NodeRef,
	deposit: { id: string; version: number; share: string },
	ownerPrivateKeyHex: string,
	opts: NodeClientOptions = {},
): Promise<{ staged: boolean }> => {
	// The body is what was signed, but the node id: the node supplies its own.
	const body = { id: deposit.id.toLowerCase(), version: deposit.version, share: deposit.share, nonce: newNonce(), ts: nowOf(opts) };
	const sig = personalSignHex(ownerPrivateKeyHex, depositMessage({ nodeId: node.id, ...body }));
	const r = await post(node.url, '/shares', { ...body, sig }, opts);
	if (r.status !== 200) throw failed(node.url, r);
	answeredAs(node, r);
	return { staged: r.body.staged === true };
};

/**
 * Asks a node for its share of secret `id`, signed by the candidate key the
 * contract elected, and opens the release with it. A 403 is the chain saying
 * not yet (`canDecrypt` is false); a 404, that the node holds nothing.
 */
export const requestRelease = async (
	node: NodeRef,
	id: string,
	candidatePrivateKeyHex: string,
	opts: NodeClientOptions = {},
): Promise<{ version: number; share: string }> => {
	const recipient = computeAddress(new SigningKey(candidatePrivateKeyHex).publicKey).toLowerCase();
	const secretId = id.toLowerCase();
	// The body is what was signed, but the node id and the secret id, which the node and the path supply.
	const body = { recipient, nonce: newNonce(), ts: nowOf(opts) };
	const sig = personalSignHex(candidatePrivateKeyHex, releaseMessage({ nodeId: node.id, id: secretId, ...body }));
	const r = await post(node.url, `/shares/${secretId}/release`, { ...body, sig }, opts);
	if (r.status !== 200) throw failed(node.url, r);
	answeredAs(node, r);
	const { version, share_ecies: shareEcies } = r.body;
	if (!Number.isSafeInteger(version) || typeof shareEcies !== 'string') throw new NodeError(node.url, r.status, 'malformed release');
	let share: string;
	try {
		share = await openRelease(shareEcies, candidatePrivateKeyHex);
	} catch (e) {
		throw new NodeError(node.url, r.status, `release does not open: ${(e as Error).message}`);
	}
	return { version, share };
};

/**
 * The version a node holds for secret `id`, or null when it holds none — a
 * node that is up but wiped counts as lost. Throws NodeError when the node
 * does not answer, which is not the same as holding nothing.
 */
export const holdingOf = async (url: string, id: string, opts: NodeClientOptions = {}): Promise<number | null> => {
	const r = await call(url, `/shares/${id.toLowerCase()}`, {}, opts);
	// The node's own 404 carries its JSON error; a proxy's, for a node that is
	// not there, does not, and is no evidence the share is gone.
	if (r.status === 404 && typeof r.body?.error === 'string') return null;
	if (r.status !== 200 || !Number.isSafeInteger(r.body?.version)) throw failed(url, r);
	return r.body.version;
};
