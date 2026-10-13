// An owner action goes the way the backup pays: from the owner's own address
// straight to the contract, or through the relayer the backup names, else the
// deployment's.
import { describe, it, expect } from 'vitest';
import { gatewayOf } from '@/lib/recovery/gateway';
import type { RecoveryChain } from '@/lib/recovery/chain';

const KEY = '0x' + '0c'.repeat(32);
const body = { id: '0x' + 'ab'.repeat(32), signer: '0x1', deadline: 1n, signature: '0xs' };

const relayer = () => {
	const urls: string[] = [];
	const fetchImpl = (async (url: string) => {
		urls.push(url);
		return new Response(JSON.stringify({ txHash: '0xt', status: 'PROCESSED' }), { status: 200 });
	}) as unknown as typeof fetch;
	return { urls, fetchImpl };
};

describe('gatewayOf', () => {
	it('sends through the relayer the backup names, else the deployment’s', async () => {
		const named = relayer();
		await gatewayOf({} as RecoveryChain, { kind: 'relayer', url: 'https://mine.example/' }, KEY, 'https://ours.example', named.fetchImpl).cancelRecovery(body);
		expect(named.urls).toEqual(['https://mine.example/api/relayer/cancel-recovery']);
		const fallback = relayer();
		await gatewayOf({} as RecoveryChain, { kind: 'relayer' }, KEY, 'https://ours.example', fallback.fetchImpl).revokeSecret(body);
		await gatewayOf({} as RecoveryChain, undefined, KEY, 'https://ours.example', fallback.fetchImpl).revokeSecret(body);
		expect(fallback.urls).toEqual(['https://ours.example/api/relayer/revoke-secret', 'https://ours.example/api/relayer/revoke-secret']);
		expect(() => gatewayOf({} as RecoveryChain, { kind: 'relayer' }, KEY, null)).toThrow(/no relayer/);
	});

	it('calls the contract from the owner’s address when the backup pays its own fee', async () => {
		const called: string[] = [];
		const contract = {
			connect: () => ({
				getFunction: (fn: string) =>
					Object.assign(async () => (called.push(fn), { hash: '0xh', wait: async () => ({}) }), { staticCall: async () => undefined }),
			}),
		};
		const chain = { provider: null, contracts: { secretRecovery: contract, keyRegistry: contract } } as unknown as RecoveryChain;
		expect(await gatewayOf(chain, { kind: 'self' }, KEY, 'https://ours.example').cancelRecovery(body)).toEqual({ txHash: '0xh', status: 'PROCESSED' });
		expect(called).toEqual(['cancelRecoveryWithSig']);
	});
});
