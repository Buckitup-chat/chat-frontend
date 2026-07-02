import { NETWORK } from './config';
import type { ShareInput } from './eip712';

interface Dispatch {
	txHash: string;
	status: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${NETWORK.relayerUrl}/api/relayer/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`relayer ${path} failed (${res.status}): ${text}`);
	}
	return res.json() as Promise<T>;
}

export const relayer = {
	addSecret(body: {
		label: string;
		shares: ShareInput[];
		threshold: number;
		recoveryDelay: string;
		signer: string;
		deadline: string;
		signature: string;
	}): Promise<Dispatch> {
		return post<Dispatch>('add-secret', body);
	},

	initiateRecovery(body: { id: string; signer: string; deadline: string; signature: string }): Promise<Dispatch> {
		return post<Dispatch>('initiate-recovery', body);
	},

	approveRecoveryBatch(body: {
		id: string;
		approvals: { candidate: string; signer: string; deadline: string; signature: string }[];
	}): Promise<Dispatch> {
		return post<Dispatch>('approve-recovery-batch', body);
	},

	cancelRecovery(body: { id: string; signer: string; deadline: string; signature: string }): Promise<Dispatch> {
		return post<Dispatch>('cancel-recovery', body);
	},

	registerKeys(body: {
		registrant: string;
		scheme: string;
		stealthMetaAddress: string;
		deadline: string;
		signature: string;
	}): Promise<Dispatch> {
		return post<Dispatch>('register-keys', body);
	},
};
