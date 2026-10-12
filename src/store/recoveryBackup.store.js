// The account's community backup (plan § 7.2): who can be a guardian, the
// nodes it knows, the fee, the alert channels, and the run that creates the
// backup — kept in one user_storage slot, so another device shows the same
// progress and never starts a second one.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { SigningKey, computeAddress, formatEther } from 'ethers';
import { v7 as uuidv7 } from 'uuid';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useRecoveryInvitesStore } from '@/store/recoveryInvites.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { fromBase64 } from '@/lib/pq/signature';
import { publishVault } from '@/lib/recovery/vault';
import { RecoveryChain } from '@/lib/recovery/chain';
import { recoveryDeployment, deploymentNamespace, secretIdOf, secretRefOf } from '@/lib/recovery/deployments';
import { directGateway, relayerGateway } from '@/lib/recovery/gateway';
import { signAddSecret } from '@/lib/recovery/typedData';
import { depositShare } from '@/lib/recovery/nodeClient';
import { liveInviteId } from '@/lib/recovery/inviteThread';
import { knownNodes, checkNode, syncedServerNode } from '@/lib/recovery/nodeDirectory';
import { RunStoppedError, advance, prepareRun, skipPendingNodes, canDiscard } from '@/lib/recovery/backupRun';
import { listSubscriptions, subscribeWebhook, telegramReply, alertWallet } from '@/lib/recovery/alerts';

export const BACKUP_SLOT = 'recovery_backup';
export const NODES_SLOT = 'recovery_nodes';
const DEVICE_KEY = 'buckitup:device-label';

/** A name for this device, kept locally: the progress screen says which device runs a backup. */
const deviceLabel = () => {
	let label = localStorage.getItem(DEVICE_KEY);
	if (!label) {
		const ua = navigator.userAgent;
		const kind = /iPhone|Android.+Mobile/.test(ua) ? 'phone' : /iPad|Tablet|Android/.test(ua) ? 'tablet' : 'computer';
		label = `${kind}-${uuidv7().slice(-6)}`;
		localStorage.setItem(DEVICE_KEY, label);
	}
	return label;
};

const hexKey = (k) => (k.startsWith('0x') ? k : `0x${k}`);

export const useRecoveryBackupStore = defineStore('recoveryBackup', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const $invites = useRecoveryInvitesStore();

	const deployment = (() => {
		try {
			return recoveryDeployment();
		} catch {
			return null;
		}
	})();

	/** The run, or the finished backup's record; null before the first backup. */
	const run = ref(null);
	const savedNodeUrls = ref([]);
	const loaded = ref(false);
	const running = ref(false);
	/** Why the last advance stopped: 'registration_pending' | 'nodes_failed' | an error message. */
	const stopped = ref(null);

	watch(() => $userPQ.currentUserHash, () => {
		run.value = null;
		savedNodeUrls.value = [];
		loaded.value = false;
		stopped.value = null;
	});

	const em = () => EncryptionManagerPQ.getInstance();

	const load = async () => {
		const owner = $userPQ.currentUserHash;
		const [backup, nodes] = await Promise.all([em().loadSlotJson(BACKUP_SLOT), em().loadSlotJson(NODES_SLOT), $invites.load({ refresh: true })]);
		if ($userPQ.currentUserHash !== owner) return;
		run.value = backup?.run ?? null;
		savedNodeUrls.value = nodes?.urls ?? [];
		loaded.value = true;
	};

	const ownerKey = async () => hexKey((await em().exportVaultKeys()).evm_skey);
	const ownerAddress = async () => computeAddress(new SigningKey(await ownerKey()).publicKey);

	// --- Guardians -------------------------------------------------------

	/**
	 * Every contact confirmed in person, with where their invitation stands
	 * for this build's deployment (design § 2): agreed contacts can be picked,
	 * the rest say why not and what to do.
	 */
	const candidates = computed(() => {
		const roster = $invites.roster;
		const ns = $invites.deployment;
		return $userPQ.contacts
			.filter((c) => c.confirmed === true)
			.map((c) => {
				const live = ns ? liveInviteId(roster, c.user_hash, ns) : null;
				const answer = live ? roster.answers?.[live] : null;
				let status = 'not_asked';
				if (live && !answer) status = 'waiting';
				else if (answer?.state === 'accepted') status = 'agreed';
				else if (answer) status = 'declined';
				return { userHash: c.user_hash, name: c.name || '', status, metaAddress: answer?.state === 'accepted' ? answer.metaAddress : null };
			});
	});
	const hiddenContacts = computed(() => $userPQ.contacts.filter((c) => c.confirmed !== true).length);

	// --- Nodes -------------------------------------------------------------

	const nodes = ref([]);
	const refusedNodes = ref({});
	const directoryDeps = () => ({
		deployment,
		operatorCard: async (userHash) => {
			const { getVerifiedSignPkey } = await import('@/lib/data/cardRegistry');
			const signPkeyB64 = await getVerifiedSignPkey(userHash);
			if (!signPkeyB64) return null;
			const name = $userPQ.contactsMap?.[userHash]?.name ?? $userPQ.allNetworkUsers?.find((u) => u.user_hash === userHash)?.name ?? '';
			return { userHash, signPkeyB64, name, deletedFlag: false };
		},
	});
	const nodeUrls = () => {
		const server = syncedServerNode(typeof ELECTRIC_API_URL !== 'undefined' ? ELECTRIC_API_URL : '/api', location.origin);
		return [...(server ? [server] : []), ...savedNodeUrls.value];
	};
	const refreshNodes = async () => {
		if (!deployment) return;
		const out = await knownNodes(nodeUrls(), directoryDeps());
		nodes.value = out.nodes;
		refusedNodes.value = out.refused;
	};
	/** Checks `url` and, if it verifies, keeps it among this account's nodes. */
	const addNodeUrl = async (url) => {
		const check = await checkNode(url, directoryDeps());
		if (check.state === 'ready') {
			const accepted = await em().patchSlotJson(NODES_SLOT, { urls: [...new Set([...savedNodeUrls.value, url])] });
			savedNodeUrls.value = accepted?.urls ?? savedNodeUrls.value;
			nodes.value = [...nodes.value.filter((n) => n.descriptor.id !== check.node.descriptor.id), check.node];
		}
		return check;
	};

	// --- Fee -----------------------------------------------------------------

	/** The owner's address, its balance and a fee estimate for registering `guardians` guardians yourself. */
	const selfPayQuote = async (guardians) => {
		const chain = new RecoveryChain(deployment);
		const address = await ownerAddress();
		const [balance, fee] = await Promise.all([chain.provider.getBalance(address), chain.provider.getFeeData()]);
		// addSecret's gas grows with its slots; a generous per-guardian figure, so the estimate errs high.
		const gas = 250_000n + 90_000n * BigInt(guardians);
		const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
		return { address, balance: formatEther(balance), estimate: formatEther(gas * price), enough: balance >= gas * price };
	};

	// --- Alerts --------------------------------------------------------------

	const alertsBase = () => deployment?.relayerUrl ?? null;
	const subscriptions = async () => (alertsBase() ? listSubscriptions(alertsBase(), await ownerKey()) : []);
	const addWebhook = async (url) => subscribeWebhook(alertsBase(), await ownerKey(), url);
	const telegramLine = async (botText) => telegramReply(botText, await ownerKey());
	const walletForBot = async () => alertWallet(await ownerKey());

	// --- The run -------------------------------------------------------------

	const save = async (next) => {
		const accepted = await em().patchSlotJson(BACKUP_SLOT, { run: next });
		run.value = accepted?.run ?? next;
	};

	const runDeps = (fee) => {
		const chain = new RecoveryChain(deployment);
		return {
			now: () => Math.floor(Date.now() / 1000),
			save,
			exportAccount: () => $userPQ.exportBackup(),
			publishVault: async (wrapKey, json) =>
				publishVault({ userHash: $userPQ.currentUserHash, signSkey: fromBase64((await em().exportVaultKeys()).sign_skey), wrapKey, json }),
			register: async (fields) => {
				const key = await ownerKey();
				const { id, body } = await signAddSecret(chain, key, fields);
				const gateway = fee?.kind === 'self' ? directGateway(chain, key) : relayerGateway(fee?.url || deployment.relayerUrl);
				const { txHash } = await gateway.addSecret(body);
				return { id, txHash };
			},
			secretIdOf,
			readVersion: async (id) => {
				const secret = await chain.readSecret(id);
				return secret ? Number(secret.version) : null;
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			deposit: async (node, d) => depositShare(node, d, await ownerKey()),
			sendShare: (guardian, part) => $dialogs.sendMessage(guardian, [part]),
			secretRefOf: (id) => secretRefOf(deployment, id),
		};
	};

	const drive = async (from, fee) => {
		running.value = true;
		stopped.value = null;
		try {
			run.value = await advance(from, runDeps(fee), (r) => (run.value = r));
		} catch (e) {
			stopped.value = e instanceof RunStoppedError ? e.reason : String(e?.message ?? e);
			if (e instanceof RunStoppedError) run.value = e.run;
		} finally {
			running.value = false;
		}
	};

	/** Starts a backup: step 1 is decided and saved before anything leaves this device. */
	const start = async ({ guardians, settings, nodes: chosen, fee, alerts }) => {
		if (!deployment) throw new Error('This app names no network to back up on.');
		if (run.value && run.value.step !== 'discarded' && run.value.step !== 'done') throw new Error('A backup is already being created.');
		const prepared = {
			...prepareRun({
				deployment: deploymentNamespace(deployment),
				owner: await ownerAddress(),
				guardians,
				settings,
				nodes: chosen.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
				device: deviceLabel(),
				now: Math.floor(Date.now() / 1000),
			}),
			fee,
			alerts,
		};
		await save(prepared);
		await drive(prepared, fee);
	};

	/** Continues the run from its saved step, on this device. */
	const resume = () => (run.value ? drive(run.value, run.value.fee) : Promise.resolve());

	/** Finishes without the nodes still pending, when the rest reach the node threshold. */
	const finishWithoutPendingNodes = async () => {
		const next = skipPendingNodes(run.value);
		await save(next);
		await drive(next, next.fee);
	};

	/** Drops a run that has not reached the chain. */
	const discard = async () => {
		if (!run.value || !canDiscard(run.value)) throw new Error('This backup already exists on the network.');
		await save({ ...run.value, step: 'discarded' });
	};

	/** Whether this device is the one running the backup (another only shows its progress). */
	const runsHere = computed(() => !!run.value && run.value.device === deviceLabel());

	return {
		deployment,
		run,
		loaded,
		running,
		stopped,
		load,
		candidates,
		hiddenContacts,
		nodes,
		refusedNodes,
		refreshNodes,
		addNodeUrl,
		selfPayQuote,
		subscriptions,
		addWebhook,
		telegramLine,
		walletForBot,
		start,
		resume,
		finishWithoutPendingNodes,
		discard,
		runsHere,
	};
});
