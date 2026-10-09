// The node plane, protocol v3. The pinned values are the SDK's
// (backitup-secret-recovery-sdk, feat/node-protocol-v3: nodeIdOf,
// signNodeDescriptor, encryptNodeRelease with a fixed ephemeral key and iv,
// buildNode*Message), so the node, the SDK and this client agree byte for byte.
import { describe, it, expect } from 'vitest';
import { SigningKey, computeAddress, verifyMessage } from 'ethers';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { toBase64 } from '@/lib/pq/signature';
import type { VerifiedCard } from '@/lib/pq/verifyCard';
import {
	NodeError,
	depositMessage,
	depositShare,
	fetchDescriptor,
	descriptorBytes,
	holdingOf,
	isStableNodeUrl,
	newerDescriptor,
	nodeIdOf,
	nodeIsUp,
	openRelease,
	releaseMessage,
	requestRelease,
	verifyDescriptor,
	type NodeDescriptor,
} from '@/lib/recovery/nodeClient';

const NODE_PRIV = '0x' + '07'.repeat(32);
const RECIPIENT_PRIV = '0x' + '09'.repeat(32);
const NODE_ID = 'n_538abbfafc74d6a13debe613540fba5f';
const NODE_PUB = '0x02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f';
const NODE_SIG =
	'0xa38cbeeaa92ddf6dde62913e0cc1032a13c86a48de7413496792009f391103931bc8c96a765394a5b9ed5618a6a4271fe31120f5fee82d016d3ecf3db7fbf5d8';
const SHARE = '801ab3ff·ünï share';
const SHARE_ECIES =
	'0505050505050505050505050505050502531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe3377e25d69908a9ceb1900e7a98e282bf92df530e3b08d5733933b33099505212608b9dd07db6afab99303c54f391b9314d0e359c97ded2bba345b5da743e9b5e8c';
const SECRET_ID = '0x' + 'ab'.repeat(32);

const URL_ = 'https://node.example/recovery/node';
const deployment = { chainId: 11155111, secretRecovery: '0xD9FFD20F2DB9c774b9f0237c4837f52DCbD937a7' };
const operatorKeys = ml_dsa87.keygen(new Uint8Array(32).fill(1));
const operator: VerifiedCard = { userHash: 'u_' + 'a'.repeat(128), signPkeyB64: toBase64(operatorKeys.publicKey), name: 'op', deletedFlag: false };

const unsigned = {
	id: NODE_ID,
	url: URL_,
	chain: 'eip155:11155111',
	contract: '0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7',
	operator: operator.userHash,
	issued_at: 1791200000,
};
// Signed once: ML-DSA-87 signing is randomized and slow, and no case edits it.
const ENDORSED: NodeDescriptor = {
	...unsigned,
	node_pubkey: NODE_PUB,
	node_sig: NODE_SIG,
	operator_sig: toBase64(ml_dsa87.sign(descriptorBytes(unsigned), operatorKeys.secretKey)),
};
const verify = (d: unknown, { card = operator as VerifiedCard | null, url = URL_, dep = deployment } = {}) =>
	verifyDescriptor(d, { url, deployment: dep }, card);

describe('the node id and descriptor', () => {
	it('derive as the SDK derives them', () => {
		expect(nodeIdOf(new SigningKey(NODE_PRIV).compressedPublicKey)).toBe(NODE_ID);
		expect(new TextDecoder().decode(descriptorBytes(unsigned))).toBe(
			`buckitup/recovery-node/v1\n${NODE_ID}\n${URL_}\neip155:11155111\n0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7\n${operator.userHash}\n1791200000`,
		);
		expect(() => nodeIdOf(new SigningKey(NODE_PRIV).publicKey)).toThrow(/compressed/);
	});

	it('verifies when the node signed it, for this deployment and URL, endorsed by its operator', () => {
		expect(verify(ENDORSED)).toEqual({ ok: true, descriptor: ENDORSED });
	});

	it('is refused for every field the node did not sign', () => {
		const d = ENDORSED;
		expect(verify({ ...d, issued_at: d.issued_at + 1 })).toMatchObject({ reason: 'bad_node_sig' });
		expect(verify({ ...d, operator: 'u_' + 'b'.repeat(128) })).toMatchObject({ reason: 'bad_node_sig' });
		expect(verify({ ...d, id: 'n_' + '0'.repeat(32) })).toMatchObject({ reason: 'bad_node_sig' });
		const other = new SigningKey('0x' + '08'.repeat(32));
		expect(verify({ ...d, node_pubkey: other.compressedPublicKey })).toMatchObject({ reason: 'bad_node_sig' });
	});

	it('refuses the malleated twin of the node signature', () => {
		const sig = hexToBytes(NODE_SIG.slice(2));
		const s = BigInt('0x' + bytesToHex(sig.slice(32)));
		const highS = (secp.CURVE.n - s).toString(16).padStart(64, '0');
		const twin = '0x' + bytesToHex(sig.slice(0, 32)) + highS;
		expect(verify({ ...ENDORSED, node_sig: twin })).toMatchObject({ reason: 'bad_node_sig' });
	});

	it('is refused when another node serves it, or it names another deployment', () => {
		expect(verify(ENDORSED, { url: 'https://other.example/recovery/node' })).toMatchObject({ reason: 'wrong_url' });
		expect(verify(ENDORSED, { dep: { ...deployment, chainId: 10 } })).toMatchObject({
			reason: 'wrong_deployment',
		});
	});

	it('is not offered without an endorsement its operator’s verified card checks', () => {
		expect(verify({ ...ENDORSED, operator_sig: null })).toMatchObject({ reason: 'not_endorsed' });
		expect(verify(ENDORSED, { card: null })).toMatchObject({ reason: 'operator_unknown' });
		expect(verify(ENDORSED, { card: { ...operator, userHash: 'u_' + 'c'.repeat(128) } })).toMatchObject({ reason: 'operator_unknown' });
		expect(verify(ENDORSED, { card: { ...operator, deletedFlag: true } })).toMatchObject({ reason: 'operator_unknown' });
		const stranger = ml_dsa87.keygen(new Uint8Array(32).fill(2));
		expect(verify({ ...ENDORSED, operator_sig: toBase64(ml_dsa87.sign(descriptorBytes(unsigned), stranger.secretKey)) })).toMatchObject({
			reason: 'bad_operator_sig',
		});
		expect(verify({ ...ENDORSED, operator_sig: 'not base64!' })).toMatchObject({ reason: 'bad_operator_sig' });
		expect(verify({ ...ENDORSED, issued_at: '1791200000' })).toMatchObject({ reason: 'malformed' });
	});

	it('is replaced by a newer issue', () => {
		const a = ENDORSED;
		const b = { ...a, issued_at: a.issued_at + 1 };
		expect(newerDescriptor(a, b)).toBe(b);
		expect(newerDescriptor(b, a)).toBe(b);
	});

	it('is offered only under a stable https name', () => {
		expect(isStableNodeUrl(URL_)).toBe(true);
		for (const url of [
			'http://node.example/recovery/node',
			'https://192.168.25.1/recovery/node',
			'https://[::1]/recovery/node',
			'https://buckitup.local/recovery/node',
			'https://localhost/recovery/node',
			'https://NODE.example/recovery/node',
			'https://u:p@node.example/recovery/node',
			'https://node.example/recovery/node?x=1',
			'https://node.example/recovery/node#f',
			'not a url',
		]) {
			expect(isStableNodeUrl(url), url).toBe(false);
		}
	});
});

describe('the signed requests', () => {
	it('are the SDK’s texts', () => {
		expect(depositMessage({ nodeId: NODE_ID, id: '0x' + 'AB'.repeat(32), version: 3, share: SHARE, nonce: 'n1', ts: 1791200000 })).toBe(
			`Backitup node share deposit v3\nnode: ${NODE_ID}\nid: ${SECRET_ID}\nversion: 3\nshare: f7f2359c2aea70e018c09c7a446de5c570e8ce7899a505ddd1e49a93ae11093c\nnonce: n1\nts: 1791200000`,
		);
		expect(releaseMessage({ nodeId: NODE_ID, id: '0x' + 'AB'.repeat(32), recipient: '0x' + 'CD'.repeat(20), nonce: 'n2', ts: 1791200001 })).toBe(
			`Backitup node share request v3\nnode: ${NODE_ID}\nid: ${SECRET_ID}\nrecipient: 0x${'cd'.repeat(20)}\nnonce: n2\nts: 1791200001`,
		);
	});
});

describe('a release', () => {
	it('opens what the SDK encrypts to the candidate key', async () => {
		expect(await openRelease(SHARE_ECIES, RECIPIENT_PRIV)).toBe(SHARE);
	});

	it('does not open under another key, or edited', async () => {
		await expect(openRelease(SHARE_ECIES, '0x' + '04'.repeat(32))).rejects.toThrow(/MAC/);
		const edited = SHARE_ECIES.slice(0, -2) + (SHARE_ECIES.endsWith('00') ? '01' : '00');
		await expect(openRelease(edited, RECIPIENT_PRIV)).rejects.toThrow(/MAC/);
		await expect(openRelease(SHARE_ECIES.slice(0, 100), RECIPIENT_PRIV)).rejects.toThrow(/short/);
	});
});

/** A fake node: records each request and answers what `answer` returns. */
const fakeNode = (answer: (path: string, body: any) => { status: number; body?: unknown; text?: string }) => {
	const requests: { path: string; body: any }[] = [];
	const fetchImpl = (async (...[input, init]: Parameters<typeof fetch>) => {
		const path = String(input).slice(URL_.length);
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		requests.push({ path, body });
		const a = answer(path, body);
		return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status: a.status });
	}) as typeof fetch;
	return { requests, fetch: fetchImpl };
};

const node = { id: NODE_ID, url: URL_ };
const OWNER_PRIV = '0x' + '0b'.repeat(32);

describe('the node client', () => {
	it('deposits a share signed by the owner, as the node rebuilds it', async () => {
		const n = fakeNode(() => ({ status: 200, body: { ok: true, nodeId: NODE_ID, staged: true } }));
		const out = await depositShare(node, { id: '0x' + 'AB'.repeat(32), version: 2, share: SHARE }, OWNER_PRIV, { fetch: n.fetch, now: () => 1791200000 });
		expect(out).toEqual({ staged: true });
		const [{ path, body }] = n.requests;
		expect(path).toBe('/shares');
		expect(body).toMatchObject({ id: SECRET_ID, version: 2, share: SHARE, ts: 1791200000 });
		const text = depositMessage({ nodeId: NODE_ID, id: body.id, version: body.version, share: body.share, nonce: body.nonce, ts: body.ts });
		expect(verifyMessage(text, body.sig)).toBe(computeAddress(new SigningKey(OWNER_PRIV).publicKey));
	});

	it('asks a release as the candidate and opens it', async () => {
		const n = fakeNode(() => ({ status: 200, body: { nodeId: NODE_ID, version: 4, share_ecies: SHARE_ECIES } }));
		expect(await requestRelease(node, SECRET_ID, RECIPIENT_PRIV, { fetch: n.fetch, now: () => 1791200000 })).toEqual({ version: 4, share: SHARE });
		const [{ path, body }] = n.requests;
		const candidate = computeAddress(new SigningKey(RECIPIENT_PRIV).publicKey);
		expect(path).toBe(`/shares/${SECRET_ID}/release`);
		expect(body.recipient).toBe(candidate.toLowerCase());
		const text = releaseMessage({ nodeId: NODE_ID, id: SECRET_ID, recipient: body.recipient, nonce: body.nonce, ts: body.ts });
		expect(verifyMessage(text, body.sig)).toBe(candidate);
	});

	it('refuses an answer from another node, and reports the node’s own refusal', async () => {
		const other = fakeNode(() => ({ status: 200, body: { nodeId: 'n_' + '0'.repeat(32), version: 4, share_ecies: SHARE_ECIES } }));
		await expect(requestRelease(node, SECRET_ID, RECIPIENT_PRIV, { fetch: other.fetch })).rejects.toThrow(/answered as/);
		const notYet = fakeNode(() => ({ status: 403, body: { error: 'canDecrypt=false: not authorized yet' } }));
		await expect(requestRelease(node, SECRET_ID, RECIPIENT_PRIV, { fetch: notYet.fetch })).rejects.toMatchObject({ status: 403 });
		const garbled = fakeNode(() => ({ status: 200, body: { nodeId: NODE_ID, version: 4, share_ecies: SHARE_ECIES.replace(/.$/, '0') } }));
		await expect(requestRelease(node, SECRET_ID, RECIPIENT_PRIV, { fetch: garbled.fetch })).rejects.toThrow(/does not open/);
	});

	it('fetches a descriptor and a health check, and tells a node that is down', async () => {
		const up = fakeNode((path) => (path === '/info' ? { status: 200, body: ENDORSED } : { status: 200, body: { nodeId: NODE_ID } }));
		expect(await fetchDescriptor(URL_, { fetch: up.fetch })).toEqual(ENDORSED);
		expect(await nodeIsUp(URL_, { fetch: up.fetch })).toBe(true);
		const unconfigured = fakeNode(() => ({ status: 503, body: { error: 'NODE_URL is not configured' } }));
		await expect(fetchDescriptor(URL_, { fetch: unconfigured.fetch })).rejects.toThrow(/NODE_URL is not configured/);
		expect(await nodeIsUp(URL_, { fetch: unconfigured.fetch })).toBe(false);
		const down = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		expect(await nodeIsUp(URL_, { fetch: down })).toBe(false);
	});

	it('reads a holding, and tells a wiped node from one that is not there', async () => {
		const held = fakeNode(() => ({ status: 200, body: { version: 3 } }));
		expect(await holdingOf(URL_, SECRET_ID, { fetch: held.fetch })).toBe(3);
		expect(held.requests[0].path).toBe(`/shares/${SECRET_ID}`);
		const wiped = fakeNode(() => ({ status: 404, body: { error: 'no share for this id on this node' } }));
		expect(await holdingOf(URL_, SECRET_ID, { fetch: wiped.fetch })).toBeNull();
		const proxy = fakeNode(() => ({ status: 404, text: '<html>Not Found</html>' }));
		await expect(holdingOf(URL_, SECRET_ID, { fetch: proxy.fetch })).rejects.toBeInstanceOf(NodeError);
		const down = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		await expect(holdingOf(URL_, SECRET_ID, { fetch: down })).rejects.toMatchObject({ status: 0 });
	});
});
