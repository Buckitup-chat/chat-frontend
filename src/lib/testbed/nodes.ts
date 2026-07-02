import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK } from './config';

function buildDepositMessage(id: string, version: number, ts: number): string {
	return `Backitup node share deposit\nid: ${id.toLowerCase()}\nversion: ${version}\nts: ${ts}`;
}

function buildShareMessage(id: string, recipient: string, ts: number): string {
	return `Backitup node share request\nid: ${id.toLowerCase()}\nrecipient: ${recipient.toLowerCase()}\nts: ${ts}`;
}

export async function depositNodeShare(
	node: { id: string; url: string },
	body: { id: string; version: number; share: string },
	ownerPrivateKey: `0x${string}`,
): Promise<void> {
	const ts = Math.floor(Date.now() / 1000);
	const account = privateKeyToAccount(ownerPrivateKey);
	const sig = await account.signMessage({ message: buildDepositMessage(body.id, body.version, ts) });
	const res = await fetch(`${node.url}/shares`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, ts, sig }),
	});
	if (!res.ok) throw new Error(`node ${node.id} deposit failed (${res.status}): ${await res.text()}`);
}

export async function fetchNodeShare(
	node: { id: string; url: string },
	id: string,
	recipient: `0x${string}`,
	recipientPrivateKey: `0x${string}`,
): Promise<string> {
	const ts = Math.floor(Date.now() / 1000);
	const account = privateKeyToAccount(recipientPrivateKey);
	const signature = await account.signMessage({ message: buildShareMessage(id, recipient, ts) });
	const qs = new URLSearchParams({ recipient, ts: String(ts), sig: signature });
	const res = await fetch(`${node.url}/shares/${id}?${qs.toString()}`);
	if (!res.ok) throw new Error(`node ${node.id} (${res.status}): ${await res.text()}`);
	const data = (await res.json()) as { share: string };
	return data.share;
}
