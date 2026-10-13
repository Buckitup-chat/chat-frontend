// A dialog page's backup pieces (pq_recovery_shares § Holding): the shares the
// peer sent are kept when the dialog opens, the peer's word on a piece this
// account sent them reaches the backup's receipts, each share and each report
// renders as what it says, and a kept share can be given back.
import { computed, ref, watch } from 'vue';
import { useRecoveryHoldingsStore } from '@/store/recoveryHoldings.store';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';
import { holdingKey } from '@/lib/recovery/holdings';
import { conflictKey, GiveBackError, holdsBytes } from '@/lib/recovery/keeping';
import { sentSharesOf } from '@/lib/recovery/receipts';
import { feedOrderKey } from '@/lib/data/feedOrder';
import { guardianDelivery } from '@/components/recovery/backup/backupFlow';
import { confirmGiveBack } from '@/components/recovery/holdingWords';

const envelopeOf = ({ kind: _kind, ...share }) => share;

/**
 * The holding a share message stands for: its refusal, or the holding of
 * the same share — unless that one keeps other bytes, which makes this
 * message a refusal not recorded yet.
 */
export const holdingFor = (holdings, owner, messageId, share) => {
	const refused = holdings[conflictKey(owner, messageId, share)];
	if (refused) return { key: conflictKey(owner, messageId, share), holding: refused };
	const key = holdingKey(owner, share);
	const held = holdings[key];
	if (!held || (holdsBytes(held) && held.share.shareB64 !== share.shareB64)) return null;
	return { key, holding: held };
};

/**
 * @param {object} o
 * @param {import('vue').Ref<string>} o.peerHash
 * @param {import('vue').Ref<object[]>} o.messages decrypted dialog entries ({ id, parts, _raw, _verify, _decrypted, _deleted })
 * @param {import('vue').Ref<string>} o.peerName
 * @param {object} o.swal
 * @param {() => boolean} o.isAlive false once the page is gone: no late prompts
 */
export function useRecoveryShares({ peerHash, messages, peerName, swal, isAlive }) {
	const $holdings = useRecoveryHoldingsStore();
	const $backup = useRecoveryBackupStore();
	const $userPQ = userPQStore();
	const givingBack = ref(false);

	/** The peer's rows that verified and say something: a share or a report is only ever taken from these. */
	const fromPeer = computed(() =>
		messages.value
			.filter((m) => m._raw?.sender_hash === peerHash.value && m._verify === 'verified' && m._decrypted && !m._deleted)
			.sort((a, b) => feedOrderKey(a._raw.message_id, a._raw.owner_timestamp) - feedOrderKey(b._raw.message_id, b._raw.owner_timestamp)),
	);

	// "The share is saved when the chat opens" (plan § 7.3): every share the
	// peer sent is handed to the account's holdings, which keep what is new.
	const received = computed(() =>
		fromPeer.value.flatMap((m) => (m.parts || []).filter((p) => p.kind === 'recovery_share').map((p) => ({ messageId: m.id, share: envelopeOf(p) }))),
	);
	watch(
		received,
		(shares) => {
			if (shares.length) $holdings.receive(peerHash.value, shares).catch((e) => console.warn('[chat] the backup piece could not be kept:', e));
		},
		{ immediate: true },
	);

	// The peer's word on the piece this account sent them, for the backup's receipts.
	const reports = computed(() =>
		fromPeer.value.filter((m) => (m.parts || []).some((p) => p.kind === 'recovery_holding')).map((m) => ({ senderHash: m._raw.sender_hash, parts: m.parts })),
	);
	watch(
		reports,
		async (list) => {
			if (!list.length) return;
			try {
				if (!$backup.loaded) await $backup.load();
				$backup.noteGuardianMessages(peerHash.value, list);
			} catch (e) {
				console.warn('[chat] the guardian\'s report could not be read:', e);
			}
		},
		{ immediate: true },
	);

	const views = computed(() => {
		const me = $userPQ.currentUserHash;
		const peer = peerHash.value;
		const sent = sentSharesOf($backup.run)[peer];
		const out = {};
		for (const m of messages.value) {
			if (m._deleted || !m._raw) continue;
			const sender = m._raw.sender_hash;
			const parts = m.parts || [];
			const share = parts.find((p) => p.kind === 'recovery_share');
			if (share && sender === peer) {
				const env = envelopeOf(share);
				const found = holdingFor($holdings.holdings, peer, m.id, env);
				out[m.id] = {
					kind: 'kept_share',
					key: found?.key ?? null,
					state: found?.holding.state ?? 'saving',
					detail: found?.holding.detail ?? '',
					version: env.version,
					shareIndex: env.shareIndex,
					canGiveBack: !!found && holdsBytes(found.holding),
				};
				continue;
			}
			if (share && sender === me) {
				const ours = sent?.messageId === m.id;
				out[m.id] = {
					kind: 'sent_share',
					state: ours ? guardianDelivery($backup.run, peer, $backup.receipts) : null,
					detail: ours ? ($backup.receiptDetails[peer]?.detail ?? '') : '',
					version: share.version,
				};
				continue;
			}
			const report = parts.find((p) => p.kind === 'recovery_holding');
			if (report && (sender === peer || sender === me)) out[m.id] = { kind: 'holding', mine: sender === me, state: report.state, detail: report.detail };
		}
		return out;
	});

	const giveBack = async (key) => {
		if (givingBack.value || !key) return;
		if (!(await confirmGiveBack(swal, peerName.value)) || !isAlive()) return;
		givingBack.value = true;
		try {
			await $holdings.giveBack(key);
		} catch (e) {
			if (isAlive()) swal.fire({ icon: 'error', title: 'The piece was not given back', text: e instanceof GiveBackError ? e.message : String(e?.message ?? e) });
		} finally {
			givingBack.value = false;
		}
	};

	return { views, givingBack, giveBack };
}
