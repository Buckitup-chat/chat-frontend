// Alert subscriptions on the notification server, signed by the owner's
// wallet (backitup-recovery-backend INTEGRATION § 9.5).
import { describe, it, expect } from 'vitest';
import { SigningKey, computeAddress, verifyMessage } from 'ethers';
import { AlertsError, subscribeMessage, subscribeWebhook, telegramReply, listSubscriptions, unsubscribe, alertHistory } from '@/lib/recovery/alerts';

const KEY = '0x' + '0c'.repeat(32);
const WALLET = computeAddress(new SigningKey(KEY).publicKey).toLowerCase();

describe('Telegram', () => {
	const NOW = 1_791_200_000;
	const botText = (over: Record<string, string> = {}) =>
		['Backitup notifications subscribe', `wallet: ${over.wallet ?? WALLET}`, `channel: ${over.channel ?? 'telegram'}`, `target: ${over.target ?? '123456789'}`, `ts: ${over.ts ?? NOW}`].join('\n');

	it('answers the bot with the address, a signature over its message, and its time', () => {
		const [wallet, sig, ts] = telegramReply(botText(), KEY, NOW + 10).split(' ');
		expect(wallet).toBe(WALLET);
		expect(ts).toBe(String(NOW));
		expect(verifyMessage(subscribeMessage(WALLET, 'telegram', '123456789', NOW), sig).toLowerCase()).toBe(WALLET);
	});

	it('signs nothing but this wallet’s fresh Telegram subscription', () => {
		for (const text of [botText({ wallet: '0x' + '1'.repeat(40) }), botText({ channel: 'webhook' }), 'Transfer 1 ETH to 0xabc', botText().replace('target: 123456789\n', '')]) {
			expect(() => telegramReply(text, KEY, NOW)).toThrow(AlertsError);
		}
		expect(() => telegramReply(botText(), KEY, NOW + 301)).toThrow(/expired/);
	});
});

describe('webhooks', () => {
	it('subscribe with a signed body and return the secret once', async () => {
		let sent: any;
		const fetchImpl = (async (url: string, init: any) => {
			sent = { url, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ id: 's1', kind: 'webhook', secret: 'sh' }), { status: 200 });
		}) as unknown as typeof fetch;
		expect(await subscribeWebhook('https://relay.example/', KEY, 'https://hook.example/x', fetchImpl)).toMatchObject({ id: 's1', secret: 'sh' });
		expect(sent.url).toBe('https://relay.example/api/notifications/subscriptions');
		const { wallet, kind, target, ts, sig } = sent.body;
		expect({ wallet, kind, target }).toEqual({ wallet: WALLET, kind: 'webhook', target: 'https://hook.example/x' });
		expect(verifyMessage(subscribeMessage(WALLET, 'webhook', target, ts), sig).toLowerCase()).toBe(WALLET);
	});

	it('report the server’s refusal', async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({ error: 'private address' }), { status: 400 })) as unknown as typeof fetch;
		await expect(subscribeWebhook('https://relay.example', KEY, 'https://10.0.0.1/x', fetchImpl)).rejects.toMatchObject({ status: 400, message: 'private address' });
		await expect(listSubscriptions('https://relay.example', KEY, fetchImpl)).rejects.toBeInstanceOf(AlertsError);
	});
});

describe('the wallet’s own records', () => {
	const recording = (answer: unknown) => {
		const seen: { url: URL; method: string }[] = [];
		const fetchImpl = (async (url: string, init: any) => {
			seen.push({ url: new URL(url), method: init?.method ?? 'GET' });
			return new Response(answer === undefined ? '' : JSON.stringify(answer), { status: 200 });
		}) as unknown as typeof fetch;
		return { seen, fetchImpl };
	};
	const readSigned = (u: URL) => verifyMessage(['Backitup notifications read', `wallet: ${WALLET}`, `ts: ${u.searchParams.get('ts')}`].join('\n'), u.searchParams.get('sig')!).toLowerCase();

	it('lists subscriptions and the alert history with a signed read', async () => {
		const subs = recording([{ id: 's1', kind: 'telegram', createdAt: 'x' }]);
		expect(await listSubscriptions('https://relay.example/', KEY, subs.fetchImpl)).toEqual([{ id: 's1', kind: 'telegram', createdAt: 'x' }]);
		expect(subs.seen[0].url.pathname).toBe('/api/notifications/subscriptions');
		expect(subs.seen[0].url.searchParams.get('wallet')).toBe(WALLET);
		expect(readSigned(subs.seen[0].url)).toBe(WALLET);

		const hist = recording([{ kind: 'initiated' }]);
		expect(await alertHistory('https://relay.example', KEY, 20, hist.fetchImpl)).toEqual([{ kind: 'initiated' }]);
		expect(hist.seen[0].url.pathname).toBe('/api/notifications');
		expect(hist.seen[0].url.searchParams.get('limit')).toBe('20');
		expect(readSigned(hist.seen[0].url)).toBe(WALLET);
		expect(await alertHistory('https://relay.example', KEY, 20, recording(null).fetchImpl)).toEqual([]);
	});

	it('deletes a subscription with a signed unsubscribe naming it', async () => {
		const del = recording(undefined);
		await unsubscribe('https://relay.example', KEY, 's/1', del.fetchImpl);
		const { url, method } = del.seen[0];
		expect(method).toBe('DELETE');
		expect(url.pathname).toBe('/api/notifications/subscriptions/s%2F1');
		const message = ['Backitup notifications unsubscribe', `wallet: ${WALLET}`, 'id: s/1', `ts: ${url.searchParams.get('ts')}`].join('\n');
		expect(verifyMessage(message, url.searchParams.get('sig')!).toLowerCase()).toBe(WALLET);
	});
});
