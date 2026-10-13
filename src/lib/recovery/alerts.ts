// Alert channels outside the app: subscriptions on a notification server,
// owned by the secret owner's wallet (backitup-recovery-backend
// docs/INTEGRATION.md § 9.5). The owner is told when a recovery of their
// secret starts and when it reaches quorum — the veto path, so a backup is not
// finished without a channel or an explicit skip (plan § 7.2).
import { addressOf, personalSignHex } from './evmSign';

export type AlertKind = 'telegram' | 'webhook';

export interface Subscription {
	id: string;
	kind: AlertKind;
	createdAt: string;
}

export class AlertsError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const walletOf = addressOf;

export const subscribeMessage = (wallet: string, channel: AlertKind, target: string, ts: number): string =>
	['Backitup notifications subscribe', `wallet: ${wallet.toLowerCase()}`, `channel: ${channel}`, `target: ${target}`, `ts: ${ts}`].join('\n');
const readMessage = (wallet: string, ts: number) => ['Backitup notifications read', `wallet: ${wallet.toLowerCase()}`, `ts: ${ts}`].join('\n');

const nowSec = () => Math.floor(Date.now() / 1000);
const TIMEOUT_MS = 20_000;

const call = async (url: string, init: Parameters<typeof fetch>[1] = {}, fetchImpl: typeof fetch = fetch) => {
	const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const text = await res.text();
	let body: any = null;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	if (!res.ok) throw new AlertsError(res.status, body?.error ?? body?.message ?? (text || `answered ${res.status}`));
	return body;
};

/** `path` on the notification server at `base`. */
const endpoint = (base: string, path: string) => `${base.replace(/\/+$/, '')}/api/notifications${path}`;

/** A read of the wallet's own records at `path`, signed with the read message; `extra` joins the query. */
const signedGet = async (base: string, ownerKey: string, path: string, extra: Record<string, string> = {}, fetchImpl?: typeof fetch) => {
	const wallet = walletOf(ownerKey);
	const ts = nowSec();
	const sig = personalSignHex(ownerKey, readMessage(wallet, ts));
	const q = new URLSearchParams({ wallet, ts: String(ts), sig, ...extra });
	return (await call(`${endpoint(base, path)}?${q}`, {}, fetchImpl)) ?? [];
};

/** The wallet's subscriptions on the server at `base` — kinds only, never targets. */
export const listSubscriptions = (base: string, ownerKey: string, fetchImpl?: typeof fetch): Promise<Subscription[]> =>
	signedGet(base, ownerKey, '/subscriptions', {}, fetchImpl);

/**
 * Subscribes a webhook. Resolves to its signing secret, which the server shows
 * once: the receiving end checks each alert with it.
 */
export const subscribeWebhook = async (base: string, ownerKey: string, target: string, fetchImpl?: typeof fetch): Promise<{ id: string; secret: string }> => {
	const wallet = walletOf(ownerKey);
	const ts = nowSec();
	const sig = personalSignHex(ownerKey, subscribeMessage(wallet, 'webhook', target, ts));
	return call(
		endpoint(base, '/subscriptions'),
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, kind: 'webhook', target, ts, sig }) },
		fetchImpl,
	);
};

/**
 * Telegram is enrolled only from the bot's chat: the owner sends it their
 * wallet address, the bot answers with the subscribe message for that chat,
 * and the owner sends back `<address> <signature> <ts>`. This checks the
 * bot's text is a subscription of this wallet to Telegram, fresh, and returns
 * the line to send; anything else is refused rather than signed.
 */
export const telegramReply = (botText: string, ownerKey: string, now = nowSec()): string => {
	const wallet = walletOf(ownerKey);
	const lines = botText.trim().split(/\r?\n/).map((l) => l.trim());
	const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
	const ts = Number(field('ts'));
	const target = field('target');
	if (lines[0] !== 'Backitup notifications subscribe' || field('wallet') !== wallet || field('channel') !== 'telegram' || !target || !Number.isSafeInteger(ts)) {
		throw new AlertsError(0, 'This is not the message the bot sends for this wallet.');
	}
	if (now - ts > 300 || ts - now > 60) throw new AlertsError(0, 'The bot\'s message has expired; ask it again.');
	const message = subscribeMessage(wallet, 'telegram', target, ts);
	return `${wallet} ${personalSignHex(ownerKey, message)} ${ts}`;
};

const unsubscribeMessage = (wallet: string, id: string, ts: number) =>
	['Backitup notifications unsubscribe', `wallet: ${wallet.toLowerCase()}`, `id: ${id}`, `ts: ${ts}`].join('\n');

/** Deletes subscription `id` of the wallet. */
export const unsubscribe = async (base: string, ownerKey: string, id: string, fetchImpl?: typeof fetch): Promise<void> => {
	const wallet = walletOf(ownerKey);
	const ts = nowSec();
	const sig = personalSignHex(ownerKey, unsubscribeMessage(wallet, id, ts));
	const q = new URLSearchParams({ wallet, ts: String(ts), sig });
	await call(`${endpoint(base, `/subscriptions/${encodeURIComponent(id)}`)}?${q}`, { method: 'DELETE' }, fetchImpl);
};

/** The wallet's alert history, newest first as the server keeps it. */
export const alertHistory = (base: string, ownerKey: string, limit = 50, fetchImpl?: typeof fetch): Promise<unknown[]> =>
	signedGet(base, ownerKey, '', { limit: String(limit) }, fetchImpl);

/** The wallet address the bot is sent first. */
export const alertWallet = walletOf;
