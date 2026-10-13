// The shares this account keeps as a guardian (pq_recovery_shares § Holding,
// § Dying; plan § 7.3): the copies in its `guardian` slot, kept once per
// account. A dialog hands in the shares its peer sent when it opens; a
// periodic pass, while the app is open and shown, asks the chain whether
// anything changed and only then takes the slot's lock to judge pending
// shares again and drop what § Dying ends. One pass runs at a time, across
// the tabs of this device, so each state is told to its owner once.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { hexToBytes } from '@noble/hashes/utils';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { withNamedLock } from '@/lib/data/storageIntent';
import { RecoveryChain, guardianChainReads } from '@/lib/recovery/chain';
import { deploymentNamespace, maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { metaKeysOf } from '@/lib/recovery/guardianInvite';
import { GUARDIAN_SLOT, consentedIn } from '@/lib/recovery/invitations';
import { holdsBytes } from '@/lib/recovery/holdings';
import { anyUnhandled, giveBack as giveBackHolding, receiveShares, secretsToCheck, sweepDue, sweepHoldings } from '@/lib/recovery/keeping';

/** How often the app asks the chain again about the shares it keeps; a tab skips its turn when another swept within half of it. */
export const SWEEP_MS = 5 * 60_000;
export const holdingsLockName = (owner) => `buckitup:holdings:${owner}`;
const sweptKey = (owner) => `buckitup:holdings-swept:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);

export const useRecoveryHoldingsStore = defineStore('recoveryHoldings', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();

	const deployment = maybeRecoveryDeployment();
	const namespace = deployment ? deploymentNamespace(deployment) : null;
	let chain = null;
	const chainOf = () => (deployment ? (chain ??= new RecoveryChain(deployment)) : null);
	const reachable = (ns) => namespace !== null && ns === namespace;

	/** The slot's holdings, by key, as last read or written. */
	const holdings = ref({});
	const loaded = ref(false);
	let loadedFor = null;

	watch(
		() => $userPQ.currentUserHash,
		() => {
			holdings.value = {};
			loaded.value = false;
			loadedFor = null;
		},
	);

	const em = () => EncryptionManagerPQ.getInstance();
	const metaKeys = async () => {
		const seed = await em().guardianMetaSeed();
		return seed ? metaKeysOf(hexToBytes(seed)) : null;
	};

	/** One pass's view of the slot and the world, for `owner`; every write refuses once another account is signed in. */
	const passDeps = (owner, known) => {
		const alive = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; nothing was written');
		};
		let answers = {};
		const reads = guardianChainReads(chainOf(), metaKeys, known);
		return {
			load: async () => {
				const slot = await em().loadSlotJson(GUARDIAN_SLOT);
				alive();
				answers = slot?.answers ?? {};
				return slot?.holdings ?? {};
			},
			save: async (entries) => {
				alive();
				const accepted = await em().patchSlotJson(GUARDIAN_SLOT, { $keyed: ['holdings'], holdings: entries });
				alive();
				const out = accepted?.holdings ?? {};
				holdings.value = out;
				return out;
			},
			send: async (to, parts) => {
				alive();
				await $dialogs.sendMessage(to, parts);
			},
			keeping: {
				reachable,
				consented: (o, ns) => consentedIn(answers, o, ns),
				readSecret: reads.readSecret,
				slotsAt: reads.slotsAt,
			},
			dying: { readSecret: reads.readSecret, addressedToMe: reads.addressedToMe },
			now: nowSec,
		};
	};

	/** Runs a pass for the signed-in account under its lock; what it returns becomes the holdings shown. */
	const exclusive = (fn, known) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return Promise.resolve(null);
		return withNamedLock(holdingsLockName(owner), async () => {
			if ($userPQ.currentUserHash !== owner) return null;
			const out = await fn(passDeps(owner, known));
			if ($userPQ.currentUserHash === owner) {
				holdings.value = out;
				loaded.value = true;
				loadedFor = owner;
			}
			return out;
		});
	};

	/** Reads the slot: once per account, or again with `refresh`. Resolves to whether it read. */
	const load = async ({ refresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || (loadedFor === owner && !refresh)) return false;
		const slot = await em().loadSlotJson(GUARDIAN_SLOT);
		if ($userPQ.currentUserHash !== owner) return false;
		holdings.value = slot?.holdings ?? {};
		loaded.value = true;
		loadedFor = owner;
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

	const sweptAt = (owner) => Number(localStorage.getItem(sweptKey(owner)) ?? 0);

	/**
	 * The periodic pass. The chain is asked first, about each secret kept, in
	 * parallel and without the lock; the slot is read again and written only
	 * when that, or a pending share or an untold state, gives the pass
	 * something to do. Skipped while the page is hidden or another tab swept
	 * lately, unless `force`d. Resolves to { read }: whether the slot was read.
	 */
	const sweep = async ({ force = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return { read: false };
		let read = await load();
		if (!force && ((typeof document !== 'undefined' && document.hidden) || Date.now() - sweptAt(owner) < SWEEP_MS / 2)) return { read };
		localStorage.setItem(sweptKey(owner), String(Date.now()));
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
		if ($userPQ.currentUserHash !== owner || !sweepDue(holdings.value, known)) return { read };
		read = (await exclusive((deps) => sweepHoldings(deps), known)) !== null || read;
		return { read };
	};

	/** Gives back the share kept under `key`, telling its owner. */
	const giveBack = (key) => exclusive((deps) => giveBackHolding(deps, key));

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
