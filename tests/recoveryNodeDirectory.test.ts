// Checking a node by its address, as the Add-node screen does (pq_recovery_services
// § Choosing nodes). The descriptor is the SDK's golden one from recoveryNodeClient.test.
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { toBase64 } from '@/lib/pq/signature';
import { descriptorBytes } from '@/lib/recovery/nodeClient';
import { checkNode, knownNodes, syncedServerNode } from '@/lib/recovery/nodeDirectory';

const URL_ = 'https://node.example/recovery/node';
const deployment = { chainId: 11155111, secretRecovery: '0xD9FFD20F2DB9c774b9f0237c4837f52DCbD937a7' };
const op = ml_dsa87.keygen(new Uint8Array(32).fill(1));
const OPERATOR = 'u_' + 'a'.repeat(128);
const unsigned = {
	id: 'n_538abbfafc74d6a13debe613540fba5f',
	url: URL_,
	chain: 'eip155:11155111',
	contract: '0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7',
	operator: OPERATOR,
	issued_at: 1791200000,
};
const DESCRIPTOR = {
	...unsigned,
	node_pubkey: '0x02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f',
	node_sig: '0xa38cbeeaa92ddf6dde62913e0cc1032a13c86a48de7413496792009f391103931bc8c96a765394a5b9ed5618a6a4271fe31120f5fee82d016d3ecf3db7fbf5d8',
	operator_sig: toBase64(ml_dsa87.sign(descriptorBytes(unsigned), op.secretKey)),
};
const card = { userHash: OPERATOR, signPkeyB64: toBase64(op.publicKey), name: 'Kyiv Hub', deletedFlag: false };

const server = (health: number) =>
	(async (url: string) => {
		if (url.endsWith('/info')) return new Response(JSON.stringify(DESCRIPTOR), { status: 200 });
		if (url.endsWith('/health')) return new Response(JSON.stringify({ nodeId: DESCRIPTOR.id }), { status: health });
		return new Response('', { status: 404 });
	}) as unknown as typeof fetch;
const deps = (over = {}) => ({ deployment, operatorCard: async () => card, fetch: server(200), ...over });

describe('checking a node by address', () => {
	it('is ready when its descriptor verifies, and says whether it is up', async () => {
		expect(await checkNode(URL_, deps())).toMatchObject({ state: 'ready', node: { online: true, descriptor: { id: DESCRIPTOR.id } } });
		expect(await checkNode(URL_, deps({ fetch: server(503) }))).toMatchObject({ state: 'ready', node: { online: false } });
	});

	it('refuses a home address, a node that does not answer, an unknown operator or another deployment', async () => {
		expect(await checkNode('http://192.168.1.24:4000', deps())).toEqual({ state: 'refused', reason: 'private_address' });
		expect(await checkNode('https://nas.home.arpa/recovery/node', deps())).toEqual({ state: 'refused', reason: 'private_address' });
		expect(await checkNode('http://node.example.org/recovery/node', deps())).toEqual({ state: 'refused', reason: 'not_https' });
		const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
		expect(await checkNode(URL_, deps({ fetch: down }))).toEqual({ state: 'refused', reason: 'unreachable' });
		expect(await checkNode(URL_, deps({ operatorCard: async () => null }))).toEqual({ state: 'refused', reason: 'operator_unknown' });
		expect(await checkNode(URL_, deps({ deployment: { ...deployment, chainId: 10 } }))).toEqual({ state: 'refused', reason: 'wrong_deployment' });
	});

	it('lists what verifies and keeps why the rest did not', async () => {
		const out = await knownNodes([URL_, URL_, 'https://other.example/recovery/node'], deps());
		expect(out.nodes).toHaveLength(1);
		expect(out.refused['https://other.example/recovery/node']).toEqual({ state: 'refused', reason: 'wrong_node' });
	});

	it('finds the node of the server this client syncs with', () => {
		expect(syncedServerNode('/api', 'https://buckitup.app')).toBe('https://buckitup.app/recovery/node');
		expect(syncedServerNode('https://srv.example/electric/v1', 'https://app.example')).toBe('https://srv.example/recovery/node');
	});
});
