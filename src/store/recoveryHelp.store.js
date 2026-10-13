// "Help someone recover" — the guardian's side of a return (plan § 7.5; chat
// repo: pq_recovery_shares § Returning, § Manual return). The guardian names
// the person's temporary account and the piece they keep, their app asks for
// a binding, the guardian compares the ten words on a call, and approves the
// candidate they checked — opening the round first if none is open — signed
// by the stealth key of their own slot, through the free service. From then
// on the app sends the piece by itself once the send gate opens (helping.ts
// sendGate), however many days that takes, while it is open on any of the
// guardian's devices: what was approved is kept in a slot of the guardian's
// own account. A piece returned by hand is sealed on request, at the gate.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useRecoveryHoldingsStore } from '@/store/recoveryHoldings.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { RecoveryChain } from '@/lib/recovery/chain';
import { deploymentNamespace, maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { gatewayOf } from '@/lib/recovery/gateway';
import { findMySlot } from '@/lib/recovery/guardianSlot';
import { metaKeysFromVault } from '@/lib/recovery/guardianInvite';
import { holdsBytes, parseSecretRef } from '@/lib/recovery/holdings';
import { latestBinding, nextCheckIn, roundMove, sendGate } from '@/lib/recovery/helping';
import { helpRequestText } from '@/lib/recovery/restoring';
import { parseBindingText, sealReturnBlock } from '@/lib/recovery/manualReturn';
import { checkBinding, recoveryWords } from '@/lib/recovery/recoveryBinding';
import { returnOf } from '@/lib/recovery/recovering';
import { signBound } from '@/lib/recovery/typedData';

export const HELP_SLOT = 'recovery_helping';
const USER_HASH = /^u_[0-9a-f]{128}$/;
const nowSec = () => Math.floor(Date.now() / 1000);
/** A sent piece stays sent: a device that has not seen it yet does not send it again. */
const sessionsPatch = (entries) => ({ $keyed: ['sessions'], $sticky: { sessions: { step: ['sent'] } }, sessions: entries });
/** How long an approval is waited for on chain before the guardian is told it did not land. */
const LANDING_TRIES = 30;
/** While nothing waits for a gate, the slot is looked at again this often. */
const IDLE_MS = 5 * 60_000;

export class HelpError extends Error {}

export const useRecoveryHelpStore = defineStore('recoveryHelp', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const $holdings = useRecoveryHoldingsStore();
	const em = () => EncryptionManagerPQ.getInstance();
	const deployment = maybeRecoveryDeployment();
	const namespace = deployment ? deploymentNamespace(deployment) : null;
	let chain = null;
	const chainOf = () => (chain ??= new RecoveryChain(deployment));
	/** Waits between reads of the chain; a test replaces it. */
	let pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const sessions = ref({});
	let loadedFor = null;

	watch(
		() => $userPQ.currentUserHash,
		() => {
			sessions.value = {};
			loadedFor = null;
			kick();
		},
	);

	/** Reads the help slot once per account; this tab's writes keep it current after. */
	const load = async () => {
		const me = $userPQ.currentUserHash;
		if (!me || loadedFor === me) return;
		const slot = await em().loadSlotJson(HELP_SLOT);
		if ($userPQ.currentUserHash !== me) return;
		sessions.value = slot?.sessions ?? {};
		loadedFor = me;
	};

	const put = async (session) => {
		const me = $userPQ.currentUserHash;
		const next = { ...session, updatedAt: nowSec() };
		const slot = await em().patchSlotJson(HELP_SLOT, sessionsPatch({ [session.key]: next }));
		if ($userPQ.currentUserHash !== me) throw new HelpError('The account changed; nothing was recorded');
		sessions.value = slot?.sessions ?? { ...sessions.value, [session.key]: next };
		return sessions.value[session.key] ?? next;
	};

	const drop = async (key) => {
		const slot = await em().patchSlotJson(HELP_SLOT, sessionsPatch({ [key]: null }));
		sessions.value = slot?.sessions ?? Object.fromEntries(Object.entries(sessions.value).filter(([k]) => k !== key));
	};

	/** The pieces a guardian can help with: kept, and checked against the chain. */
	const helpable = computed(() => $holdings.list.filter((h) => h.state === 'stored' && holdsBytes(h)));

	const holdingOf = (key) => {
		const h = $holdings.holdings[key];
		if (!h || !holdsBytes(h)) throw new HelpError('You no longer keep this piece.');
		return h;
	};

	const secretOf = (h) => {
		const ref = parseSecretRef(h.share.secretRef);
		if (!ref || !namespace || ref.namespace !== namespace) throw new HelpError('This piece is for a network this app does not reach.');
		return ref.id;
	};

	/**
	 * Asks the person's temporary account, in a dialog this guardian opens with
	 * it, for its binding: the first message carries the piece's secret_ref
	 * (§ Returning, step 2).
	 */
	const ask = async ({ peer, holdingKey }) => {
		const me = $userPQ.currentUserHash;
		const temp = (peer ?? '').trim();
		if (!USER_HASH.test(temp)) throw new HelpError('This is not a recovery code: it starts with u_ and is 130 characters long.');
		if (temp === me) throw new HelpError('This is your own account.');
		await $holdings.load();
		const h = holdingOf(holdingKey);
		secretOf(h);
		await $dialogs.sendMessage(temp, [{ kind: 'text', text: helpRequestText(h.share.secretRef) }]);
		return put({ key: `${holdingKey}|${temp}`, holdingKey, owner: h.owner, secretRef: h.share.secretRef, mode: 'dialog', peer: temp, step: 'asked', askedAt: nowSec() });
	};

	/** The same request outside the app (§ Manual return): the text to send by another messenger. */
	const askByText = async ({ holdingKey }) => {
		await $holdings.load();
		const h = holdingOf(holdingKey);
		secretOf(h);
		const at = nowSec();
		const session = await put({ key: `${holdingKey}|text:${at}`, holdingKey, owner: h.owner, secretRef: h.share.secretRef, mode: 'text', peer: null, step: 'asked', askedAt: at });
		return { session, text: helpRequestText(h.share.secretRef) };
	};

	/**
	 * The person's answer, checked: { candidate, peer, words } — or null while
	 * none came. The words are computed here from what this guardian sent and
	 * what came back; the person reads theirs out.
	 */
	const bindingOf = async (session) => {
		// Only the newest binding for this backup counts: the rows before it are not decrypted.
		const read = await $dialogs.readPeerParts(session.peer, ['recovery_binding'], { newestMatch: (p) => p.secretRef === session.secretRef });
		if (!read) throw new HelpError('Their messages could not be read just now. Try again in a moment.');
		const found = latestBinding(read.messages, { secretRef: session.secretRef, peer: session.peer });
		if (!found) return null;
		if (!found.ok) throw new HelpError(`Their answer does not check out (${found.reason}). Do not approve.`);
		return { candidate: found.candidate, peer: session.peer, words: recoveryWords(session.secretRef, found.candidate, session.peer) };
	};

	/**
	 * A binding pasted by hand. The user_hash it names stands in for the dialog
	 * peer, and the words say whether it is the person's on the call; its card
	 * must be here, since the piece will be sealed to its key.
	 */
	const typedBinding = (session, text) => {
		const binding = parseBindingText(text);
		const candidate = checkBinding(binding, { secretRef: session.secretRef, dialogPeerUserHash: binding.userHash });
		const card = $userPQ.getUserByHash?.(binding.userHash);
		if (!card?.crypt_pkey) throw new HelpError('Their temporary account is not on this server yet. Ask them to wait a minute, then try again.');
		return { candidate, peer: binding.userHash, words: recoveryWords(session.secretRef, candidate, binding.userHash) };
	};

	const metaKeys = async () => {
		const keys = await metaKeysFromVault(em());
		if (!keys) throw new HelpError('This account has no guardian keys.');
		return keys;
	};

	const landed = async (check, what) => {
		for (let i = 0; i < LANDING_TRIES; i++) {
			if (await check()) return;
			await pause((deployment.blockTime || 12) * 1000);
		}
		throw new HelpError(`${what} was sent but has not reached the network yet. Open this again in a few minutes.`);
	};

	/**
	 * The words matched: approve `candidate` for this piece — opening the
	 * round if none is open — and record what was approved, so the piece goes
	 * once the gate opens.
	 */
	const approve = async (session, { candidate, peer }) => {
		const c = chainOf();
		const h = holdingOf(session.holdingKey);
		const id = secretOf(h);
		const secret = await c.readSecret(id);
		if (!secret) throw new HelpError('The network holds no such backup any more.');
		if (secret.revoked) throw new HelpError('This backup was revoked: nobody can recover with it.');
		if (Number(secret.version) !== h.share.version) {
			throw new HelpError('The piece you keep is from an earlier version of this backup. Your approval would count, but your piece could not be used.');
		}
		const slot = await findMySlot(c, id, Number(secret.version), await metaKeys());
		if (!slot) throw new HelpError('This backup no longer lists you as a guardian.');
		const state = await c.roundState(id);
		const move = roundMove(state, await c.hasApproved(id, candidate, slot.stealthAddress));
		if (move === 'closed') throw new HelpError('Enough guardians already approved a device without you. Your piece is not needed this time.');
		// The stealth key has no coins: approvals go through the free service.
		const gateway = gatewayOf(c, { kind: 'relayer' }, slot.privateKey, deployment.relayerUrl);
		if (move === 'initiate') {
			const before = secret.recoveryRound;
			const { body } = await signBound(c, slot.privateKey, 'InitiateRecovery', id, {});
			await gateway.initiateRecovery(body);
			// The approval is signed for the round the initiation opens.
			await landed(async () => (await c.readSecret(id)).recoveryRound > before && (await c.roundState(id)) === RoundState.Voting, 'The start of the recovery');
		}
		let round = Number((await c.readSecret(id)).recoveryRound);
		if (move !== 'approved') {
			const { body, secret: signed } = await signBound(c, slot.privateKey, 'ApproveRecovery', id, { candidate });
			round = Number(signed.recoveryRound);
			await gateway.approveRecovery(body);
			await landed(() => c.hasApproved(id, candidate, slot.stealthAddress), 'Your approval');
		}
		const next = await put({
			...session,
			peer,
			step: 'approved',
			candidate,
			round,
			heldVersion: h.share.version,
			stealthAddress: slot.stealthAddress,
			approvedAt: nowSec(),
		});
		await tick();
		return sessions.value[next.key] ?? next;
	};

	/** Where one approved session stands at the gate, read from the chain now. */
	const gateOf = async (s) => {
		const c = chainOf();
		const id = parseSecretRef(s.secretRef).id;
		const [secret, state, hasApproved] = await Promise.all([c.readSecret(id), c.roundState(id), c.hasApproved(id, s.candidate, s.stealthAddress)]);
		return sendGate({ secret, state, hasApproved, approved: { candidate: s.candidate, round: s.round, heldVersion: s.heldVersion }, now: nowSec() });
	};

	/** The return of the piece kept for `s`, for the round and candidate approved; returnOf takes only the envelope's fields. */
	const returnFor = (s) => returnOf(holdingOf(s.holdingKey).share, s.round, s.candidate, nowSec());

	let ticking = null;
	/**
	 * Applies the gate to every approved session: sends the piece in the
	 * dialog, marks a piece to be returned by hand ready, or stops for good.
	 * Resolves to the seconds until the chain is worth asking again.
	 */
	const tick = () => {
		const me = $userPQ.currentUserHash;
		if (!me || !deployment) return Promise.resolve(null);
		ticking ??= (async () => {
			let next = null;
			try {
				await load();
				const due = Object.values(sessions.value).filter((s) => s.step === 'approved' || s.step === 'ready');
				if (due.length) await $holdings.load();
				for (const s of due) {
					if ($userPQ.currentUserHash !== me) return null;
					let gate;
					try {
						gate = await gateOf(s);
					} catch (e) {
						console.warn('[recovery] the recovery could not be read:', e);
						next = Math.min(next ?? 60, 60);
						continue;
					}
					if (gate.kind === 'wait') {
						next = Math.min(next ?? Infinity, nextCheckIn(gate, nowSec(), deployment.blockTime));
					} else if (gate.kind === 'stop') {
						await put({ ...s, step: 'stopped', reason: gate.reason });
					} else if (s.mode === 'dialog') {
						let part;
						try {
							part = returnFor(s);
						} catch (e) {
							await put({ ...s, step: 'stopped', reason: e.message });
							continue;
						}
						await $dialogs.sendMessage(s.peer, [part]);
						await put({ ...s, step: 'sent', sentAt: nowSec() });
					} else if (s.step !== 'ready') {
						await put({ ...s, step: 'ready' });
					}
				}
			} finally {
				ticking = null;
			}
			return next;
		})();
		return ticking;
	};

	/**
	 * The piece as text for a session returned by hand, made only while the
	 * gate is open: the block to send and the six digits to read out.
	 */
	const sealFor = async (session) => {
		const gate = await gateOf(session);
		if (gate.kind !== 'send') throw new HelpError(gate.kind === 'stop' ? `Not now: ${gate.reason}.` : 'Not yet: the waiting period is not over.');
		const card = $userPQ.getUserByHash?.(session.peer);
		if (!card?.crypt_pkey) throw new HelpError('Their temporary account is not on this server.');
		return sealReturnBlock({
			cryptPkey: card.crypt_pkey,
			part: returnFor(session),
			guardianUserHash: $userPQ.currentUserHash,
			sign: (bytes) => em().signChallenge(bytes),
		});
	};

	/** The guardian sent the block and read the digits out. */
	const markSent = (session) => put({ ...session, step: 'sent', sentAt: nowSec() });

	/** Forgets a help that has not sent anything. */
	const cancel = async (session) => {
		if (session.step === 'sent') return;
		await drop(session.key);
	};

	/** Every help this account gave or is giving, newest first. */
	const list = computed(() => Object.values(sessions.value).sort((a, b) => (b.askedAt ?? 0) - (a.askedAt ?? 0)));

	let timer = null;
	let watching = false;
	/** Bumped by every kick: a turn of an older generation, still awaiting its tick, does not schedule another. */
	let generation = 0;
	const loop = async (gen) => {
		let next = null;
		try {
			next = await tick();
		} catch (e) {
			console.warn('[recovery] a piece could not be sent:', e);
		}
		if (watching && gen === generation) timer = setTimeout(() => loop(gen), next === null || next === Infinity ? IDLE_MS : next * 1000);
	};
	/** Looks now rather than at the next turn: another account signed in. */
	const kick = () => {
		if (!watching) return;
		clearTimeout(timer);
		const gen = ++generation;
		timer = setTimeout(() => loop(gen), 0);
	};
	/** While the app is open, applies the gate as often as the chain is worth asking; once, however often called. */
	const watchWhileOpen = () => {
		if (watching || !deployment) return;
		watching = true;
		kick();
	};
	const stopWatching = () => {
		watching = false;
		clearTimeout(timer);
		timer = null;
	};

	/** A test's clock for waits on the chain. */
	const setPause = (fn) => {
		pause = fn;
	};

	return {
		deployment,
		sessions,
		list,
		helpable,
		load,
		ask,
		askByText,
		bindingOf,
		typedBinding,
		approve,
		tick,
		sealFor,
		markSent,
		cancel,
		watchWhileOpen,
		stopWatching,
		setPause,
	};
});
