// The shares this account keeps as a guardian (pq_recovery_shares § Holding,
// § Dying; plan § 7.3): the copies in its `guardian` slot, kept once per
// account. A dialog hands in the shares its peer sent when it opens; a
// periodic pass, while the app is open, reads the chain again for pending
// shares and drops the ones § Dying ends. One pass runs at a time, across the
// tabs of this device, so each state is told to its owner once.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { RecoveryChain } from '@/lib/recovery/chain';
import { deploymentNamespace, recoveryDeployment } from '@/lib/recovery/deployments';
import { GUARDIAN_SLOT } from '@/lib/recovery/invitations';
import { anyUnhandled, chainContexts, giveBack as giveBackHolding, needsSweep, receiveShares, sweepHoldings } from '@/lib/recovery/keeping';

/** How often the app reads the chain again for the shares it keeps. */
export const SWEEP_MS = 5 * 60_000;
export const holdingsLockName = (owner) => `buckitup:holdings:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);

export const useRecoveryHoldingsStore = defineStore('recoveryHoldings', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();

	const deployment = (() => {
		try {
			return recoveryDeployment();
		} catch {
			return null;
		}
	})();
	const namespace = deployment ? deploymentNamespace(deployment) : null;
	let chain = null;
	const chainOf = () => (chain ??= new RecoveryChain(deployment));
	/** Without a deployment nothing is reachable, and no read is made. */
	const offChain = {
		readSecret: async () => {
			throw new Error('This app names no network to read.');
		},
		guardiansAt: async () => [],
		shareAt: async () => {
			throw new Error('This app names no network to read.');
		},
	};

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

	/** One pass's view of the slot and the world, for `owner`; every write refuses once another account is signed in. */
	const passDeps = (owner) => {
		const alive = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; nothing was written');
		};
		let answers = {};
		const { keeping, dying } = chainContexts({
			chain: deployment ? chainOf() : offChain,
			namespace,
			answers: () => answers,
			metaSeed: () => em().guardianMetaSeed(),
		});
		return {
			load: async () => {
				const slot = await em().loadSlotJson(GUARDIAN_SLOT);
				alive();
				answers = slot?.answers ?? {};
				return slot?.holdings ?? {};
			},
			save: async (entries) => {
				alive();
				const accepted = await em().patchSlotJson(GUARDIAN_SLOT, { holdings: entries });
				alive();
				const out = accepted?.holdings ?? {};
				holdings.value = out;
				return out;
			},
			send: async (to, parts) => {
				alive();
				await $dialogs.sendMessage(to, parts);
			},
			keeping,
			dying,
			now: nowSec,
		};
	};

	// One pass at a time: in this tab through the chain, across tabs through the lock.
	let queue = Promise.resolve();
	const exclusive = (fn) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return Promise.resolve(null);
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		const run = queue.then(async () => {
			if ($userPQ.currentUserHash !== owner) return null;
			const deps = passDeps(owner);
			const go = async () => {
				const out = await fn(deps);
				if ($userPQ.currentUserHash === owner) {
					holdings.value = out;
					loaded.value = true;
					loadedFor = owner;
				}
				return out;
			};
			return locks?.request ? locks.request(holdingsLockName(owner), go) : go();
		});
		queue = run.catch(() => {});
		return run;
	};

	/** Reads the slot: once per account, or again with `refresh`. */
	const load = async ({ refresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || (loadedFor === owner && !refresh)) return;
		const slot = await em().loadSlotJson(GUARDIAN_SLOT);
		if ($userPQ.currentUserHash !== owner) return;
		holdings.value = slot?.holdings ?? {};
		loaded.value = true;
		loadedFor = owner;
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

	/** The periodic pass; skipped while nothing is kept that it would change. */
	const sweep = async () => {
		if (!$userPQ.currentUserHash) return;
		await load();
		if (!needsSweep(holdings.value)) return;
		await exclusive((deps) => sweepHoldings(deps));
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
			.sort((a, b) => Number(['given_back', 'dropped'].includes(a.state)) - Number(['given_back', 'dropped'].includes(b.state)) || b.updatedAt - a.updatedAt),
	);

	return { holdings, list, loaded, load, receive, sweep, giveBack, watchWhileOpen };
});
