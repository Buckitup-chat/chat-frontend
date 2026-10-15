// Who opened a dialog with an account (pq_dialogs § Participation): read from
// one live collection of the dialog_keys naming it as peer, each sender once,
// never the account itself, never a deleted key.
import { describe, it, expect, vi } from 'vitest';

const ME = 'u_' + 'e'.repeat(128);
const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const H = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], built: [] as string[], preloads: 0, subs: 0 }));
vi.mock('@/lib/data/collections', () => {
	const colls = new Map<string, unknown>();
	return {
		getInboundDialogKeysCollection: (me: string) => {
			if (!colls.has(me)) {
				H.built.push(me);
				colls.set(me, {
					preload: async () => void H.preloads++,
					get toArray() {
						return H.rows;
					},
					subscribeChanges: () => (H.subs++, { unsubscribe: () => void H.subs-- }),
				});
			}
			return colls.get(me);
		},
	};
});

const { followPeersWhoWrote, peersIn, peersWhoWrote } = await import('@/lib/data/inboundDialogs');

describe('who wrote to an account', () => {
	it('is each sender of a live key naming it, once', () => {
		const rows = [
			{ sender_hash: A, peer_hash: ME, deleted_flag: false },
			{ sender_hash: A, peer_hash: ME, deleted_flag: false },
			{ sender_hash: B, peer_hash: ME, deleted_flag: 't' },
			{ sender_hash: ME, peer_hash: ME, deleted_flag: false },
			{ sender_hash: B, peer_hash: A, deleted_flag: false },
			{ sender_hash: 'nonsense', peer_hash: ME, deleted_flag: false },
		];
		expect(peersIn(rows, ME)).toEqual([A]);
	});

	it('comes from one collection per account, followed while a screen shows it', async () => {
		H.rows = [{ sender_hash: A, peer_hash: ME, deleted_flag: false }];
		expect(await peersWhoWrote(ME)).toEqual([A]);
		H.rows = [...H.rows, { sender_hash: B, peer_hash: ME, deleted_flag: false }];
		expect(await peersWhoWrote(ME)).toEqual([A, B]);
		expect(H.built).toEqual([ME]);
		const stop = followPeersWhoWrote(ME);
		expect(H.subs).toBe(1);
		stop();
		expect(H.subs).toBe(0);
	});
});
