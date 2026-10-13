// The shares this account keeps as a guardian (pq_recovery_shares § Holding,
// § Dying; plan § 7.3): the copies in its `guardian` slot, kept once per
// account. A dialog hands in the shares its peer sent when it opens; a
// periodic pass, while the app is open and shown, asks the chain whether
// anything changed and only then takes the slot's lock to judge pending
// shares again, follow the guardian's consent and drop what § Dying ends. One
// pass runs at a time, across the tabs of this device, so each state is told
// to its owner once.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { hexToBytes } from '@noble/hashes/utils';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { mergeJsonPatch, stripPatchDirectives, withNamedLock } from '@/lib/data/storageIntent';
import { StorageNotOnServerError } from '@/lib/data/userStorage';
import { RecoveryChain, guardianChainReads } from '@/lib/recovery/chain';
import { deploymentNamespace, maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { GUARDIAN_SLOT, consentedIn } from '@/lib/recovery/invitations';
import { holdsBytes } from '@/lib/recovery/holdings';
import { anyUnhandled, giveBack as giveBackHolding, holdingsPatch, receiveShares, secretsToCheck, sweepDue, sweepHoldings } from '@/lib/recovery/keeping';

/** How often the app asks the chain again about the shares it keeps; a tab skips its turn when another swept within half of it. */
export const SWEEP_MS = 5 * 60_000;
export const holdingsLockName = (owner) => `buckitup:holdings:${owner}`;
const sweptKey = (owner) => `buckitup:holdings-swept:${owner}`;
const changedKey = (owner) => `buckitup:holdings-changed:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const readStamp = (key) => (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '';
const setStamp = (key, value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(value));
	return String(value);
};

/**
 * Says the guardian slot of `owner` changed here — holdings or answers — so
 * the other tabs read it again before deciding anything from memory. The
 * stamp is unique per write, so two writes in one millisecond still differ.
 */
export const markGuardianSlotChanged = (owner) => setStamp(changedKey(owner), `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const useRecoveryHoldingsStore = defineStore('recoveryHoldings', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();

	const deployment = maybeRecoveryDeployment();
	const namespace = deployment ? deploymentNamespace(deployment) : null;
	let chain = null;
	const chainOf = () => (deployment ? (chain ??= new RecoveryChain(deployment)) : null);
	const reachable = (ns) => namespace !== null && ns === namespace;

	/** The slot's holdings, by key, and the guardian's answers beside them, as last read or written. */
	const holdings = ref({});
	const answers = ref({});
	const loaded = ref(false);
	let loadedFor = null;
	/** The change stamp as of this tab's last read or write of the slot: another one means another tab wrote since. */
	let seenStamp = '';

	watch(
		() => $userPQ.currentUserHash,
		() => {
			holdings.value = {};
			answers.value = {};
			loaded.value = false;
			loadedFor = null;
			seenStamp = '';
		},
	);

	const em = () => EncryptionManagerPQ.getInstance();
	const metaKeys = async () => {
		const seed = await em().guardianMetaSeed();
		return seed ? metaKeysOf(hexToBytes(seed)) : null;
	};

	/** Takes `slot`, read or written when the change stamp was `stamp`, as this tab's view of `owner`'s slot. */
	const take = (owner, slot, stamp) => {
		holdings.value = slot?.holdings ?? {};
		answers.value = slot?.answers ?? {};
		loaded.value = true;
		loadedFor = owner;
		seenStamp = stamp;
	};

	/**
	 * One pass's view of the slot and the world, for `owner`; every write
	 * refuses once another account is signed in. A write the server has not
	 * taken yet but the outbox holds goes on from its local value, and the
	 * pass is marked `queued`: what it tells the owner is queued the same way.
	 */
	const passDeps = (owner, known) => {
		const alive = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; nothing was written');
		};
		let slotAnswers = {};
		let last = {};
		const reads = guardianChainReads(chainOf(), metaKeys, known);
		const deps = {
			queued: false,
			load: async () => {
				const stamp = readStamp(changedKey(owner));
				const slot = await em().loadSlotJson(GUARDIAN_SLOT);
				alive();
				slotAnswers = slot?.answers ?? {};
				last = slot?.holdings ?? {};
				take(owner, slot, stamp);
				return last;
			},
			save: async (entries) => {
				alive();
				const patch = holdingsPatch(entries);
				let accepted;
				try {
					accepted = (await em().patchSlotJson(GUARDIAN_SLOT, patch))?.holdings ?? {};
				} catch (e) {
					if (!(e instanceof StorageNotOnServerError)) throw e;
					deps.queued = true;
					accepted = stripPatchDirectives(mergeJsonPatch({ holdings: last }, patch)).holdings ?? {};
				}
				alive();
				last = accepted;
				take(owner, { holdings: accepted, answers: slotAnswers }, markGuardianSlotChanged(owner));
				return accepted;
			},
			send: async (to, parts) => {
				alive();
				await $dialogs.sendMessage(to, parts);
			},
			keeping: {
				reachable,
				consented: (o, ns) => consentedIn(slotAnswers, o, ns),
				readSecret: reads.readSecret,
				slotsAt: reads.slotsAt,
			},
			dying: { readSecret: reads.readSecret, addressedToMe: reads.addressedToMe },
			now: nowSec,
		};
		return deps;
	};

	/**
	 * Runs a pass for the signed-in account under its lock. Resolves to
	 * { holdings, queued } — null once another account is signed in — and
	 * what it returns becomes the holdings shown.
	 */
	const exclusive = (fn, known) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return Promise.resolve(null);
		return withNamedLock(holdingsLockName(owner), async () => {
			if ($userPQ.currentUserHash !== owner) return null;
			const deps = passDeps(owner, known);
			const out = await fn(deps);
			if ($userPQ.currentUserHash !== owner) return null;
			holdings.value = out;
			return { holdings: out, queued: deps.queued };
		});
	};

	/**
	 * Reads the slot: once per account, again with `refresh`, and again
	 * whenever another tab wrote it since this tab last did. Resolves to
	 * whether it read.
	 */
	const load = async ({ refresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		// The stamp is read before the slot: a write landing in between is read again next time.
		const stamp = readStamp(changedKey(owner));
		if (!owner || (loadedFor === owner && !refresh && stamp === seenStamp)) return false;
		const slot = await em().loadSlotJson(GUARDIAN_SLOT);
		if ($userPQ.currentUserHash !== owner) return false;
		take(owner, slot, stamp);
		return true;
	};

	/**
	 * Keeps the shares `peerHash` sent in their dialog ({ messageId, share }).
	 * A dialog calls this on every render; shares already handled cost one
	 * comparison against the holdings in memory.
	 */
	const receive = async (peerHash, received) => {
		if (!received.length || !peerHash || peerHash === $userPQ.currentUserHash) return;
		await load();
		if (!anyUnhandled(peerHash, received, holdings.value)) return;
		await exclusive((deps) => receiveShares(deps, peerHash, received));
	};

	/**
	 * The periodic pass. The chain is asked first, about each secret kept, in
	 * parallel and without the lock; the slot is read again and written only
	 * when that, a pending share, an untold state or a change of the
	 * guardian's consent gives the pass something to do. Skipped while the
	 * page is hidden or another tab swept lately, unless `force`d. Resolves to
	 * { read }: whether the slot was read.
	 */
	const sweep = async ({ force = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return { read: false };
		let read = await load();
		if (!force && ((typeof document !== 'undefined' && document.hidden) || Date.now() - Number(readStamp(sweptKey(owner)) || 0) < SWEEP_MS / 2)) return { read };
		setStamp(sweptKey(owner), Date.now());
		const ids = secretsToCheck(holdings.value, reachable);
		const known = new Map();
		const c = chainOf();
		await Promise.all(
			ids.map(async (id) => {
				try {
					const s = await c.readSecret(id);
					known.set(id, s ? { version: Number(s.version), revoked: s.revoked } : null);
				} catch (e) {
					console.warn('[recovery] a kept share\'s secret could not be read:', id, e);
				}
			}),
		);
		if ($userPQ.currentUserHash !== owner || !sweepDue(holdings.value, known, (o, ns) => consentedIn(answers.value, o, ns))) return { read };
		read = (await exclusive((deps) => sweepHoldings(deps), known)) !== null || read;
		return { read };
	};

	/**
	 * Gives back the share kept under `key`, telling its owner. Resolves to
	 * { queued }: true when it is given back on this device and reaches the
	 * server, and the owner, once the network returns.
	 */
	const giveBack = async (key) => ({ queued: !!(await exclusive((deps) => giveBackHolding(deps, key)))?.queued });

	let timer = null;
	/** Sweeps every SWEEP_MS while the app is open; once, however often called. */
	const watchWhileOpen = () => {
		timer ??= setInterval(() => {
			sweep().catch((e) => console.warn('[recovery] the shares kept could not be checked:', e));
		}, SWEEP_MS);
	};

	/** The holdings as a list: what is kept first, then given back or dropped; refusals are the dialog's to show. */
	const list = computed(() =>
		Object.entries(holdings.value)
			.filter(([, h]) => h.state !== 'conflict')
			.map(([key, h]) => ({ key, ...h }))
			.sort((a, b) => Number(!holdsBytes(a)) - Number(!holdsBytes(b)) || b.updatedAt - a.updatedAt),
	);

	return { holdings, list, loaded, load, receive, sweep, giveBack, watchWhileOpen };
});
