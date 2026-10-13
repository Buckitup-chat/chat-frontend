// The account's community backup (plan § 7.2): who can be a guardian, the
// nodes it knows, the fee, the alert channels, and the run that creates the
// backup — kept in one user_storage slot, so another device shows the same
// progress and never starts a second one.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { formatEther } from 'ethers';
import { v7 as uuidv7 } from 'uuid';
import { userPQStore } from '@/store/userPQ.store';
import errorMessage from '@/utils/errorMessage';
import { useDialogsStore } from '@/store/dialogs.store';
import { useRecoveryInvitesStore } from '@/store/recoveryInvites.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { fromBase64 } from '@/lib/pq/signature';
import { publishVault } from '@/lib/recovery/vault';
import { RecoveryChain } from '@/lib/recovery/chain';
import { recoveryDeployment, deploymentNamespace, secretIdOf, secretRefOf } from '@/lib/recovery/deployments';
import { directGateway, relayerGateway } from '@/lib/recovery/gateway';
import { signAddSecret, signBound } from '@/lib/recovery/typedData';
import { depositShare } from '@/lib/recovery/nodeClient';
import { liveInviteId } from '@/lib/recovery/inviteThread';
import { knownNodes, checkNode, syncedServerNode } from '@/lib/recovery/nodeDirectory';
import { RunInterruptedError, RunAbortedError, RunTakenOverError, RunStoppedError, advance, prepareRun, skipPendingNodes, canDiscard, sharePartOf } from '@/lib/recovery/backupRun';
import { settingsProblems } from '@/lib/recovery/backupPlan';
import { setProblems } from '@/lib/recovery/nodeChoice';
import { listSubscriptions, subscribeWebhook, telegramReply, alertWallet, unsubscribe, alertHistory } from '@/lib/recovery/alerts';

export const BACKUP_SLOT = 'recovery_backup';
export const NODES_SLOT = 'recovery_nodes';
const DEVICE_KEY = 'buckitup:device-label';
/** How often a run driven elsewhere — another device or tab — is read again while a screen follows it. */
const FOLLOW_MS = 15_000;
/** A run another device has not moved for this long may be continued here: that device may be lost. */
export const TAKEOVER_AFTER_SEC = 10 * 60;
/** One tab of one device drives an account's run at a time. */
export const runLockName = (owner) => `buckitup:backup-run:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const unfinished = (r) => !!r && r.step !== 'done' && r.step !== 'discarded';

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
	/** Another tab of this device holds the run's lock: it drives the run, this one only shows it. */
	const heldElsewhere = ref(false);
	/** Seconds, as last looked: what a stale run is measured against. */
	const clock = ref(nowSec());

	watch(() => $userPQ.currentUserHash, () => {
		ownerAddressOf = null;
		run.value = null;
		savedNodeUrls.value = [];
		loaded.value = false;
		stopped.value = null;
		heldElsewhere.value = false;
	});

	const em = () => EncryptionManagerPQ.getInstance();

	const locks = () => (typeof navigator !== 'undefined' ? navigator.locks : undefined);
	/** Whether another tab of this device drives the run now. */
	const checkHeld = async (owner) => {
		const held = locks()?.query ? ((await locks().query()).held ?? []) : [];
		if ($userPQ.currentUserHash === owner) heldElsewhere.value = !running.value && held.some((l) => l.name === runLockName(owner));
	};

	/** The run as `owner`'s slot holds it now; throws RunAbortedError once another account is signed in. */
	const readRun = async (owner) => {
		const backup = await em().loadSlotJson(BACKUP_SLOT);
		if ($userPQ.currentUserHash !== owner) throw new RunAbortedError();
		return backup?.run ?? null;
	};

	const load = async () => {
		const owner = $userPQ.currentUserHash;
		const [backup, nodes] = await Promise.all([em().loadSlotJson(BACKUP_SLOT), em().loadSlotJson(NODES_SLOT), $invites.load({ refresh: true }), checkHeld(owner)]);
		if ($userPQ.currentUserHash !== owner) return;
		clock.value = nowSec();
		if (!running.value) run.value = backup?.run ?? null;
		savedNodeUrls.value = nodes?.urls ?? [];
		loaded.value = true;
	};

	/** Only the run's slot, for following a run another device or tab drives. */
	const refreshRun = async () => {
		const owner = $userPQ.currentUserHash;
		const [latest] = await Promise.all([readRun(owner).catch(() => undefined), checkHeld(owner)]);
		clock.value = nowSec();
		if (latest === undefined || running.value) return;
		run.value = latest;
	};

	// Screens that show an unfinished run follow it; nothing is read while none does.
	let followers = 0;
	let followTimer = null;
	const follow = () => {
		followers += 1;
		followTimer ??= setInterval(() => {
			clock.value = nowSec();
			if (running.value || !unfinished(run.value)) return;
			refreshRun().catch((e) => console.warn('[recovery] the backup run could not be read:', e));
		}, FOLLOW_MS);
	};
	const unfollow = () => {
		followers = Math.max(0, followers - 1);
		if (!followers && followTimer) {
			clearInterval(followTimer);
			followTimer = null;
		}
	};

	const ownerKey = async () => hexKey((await em().exportVaultKeys()).evm_skey);
	/** The owner's EVM address, lowercase, for this account. */
	let ownerAddressOf = null;
	const ownerAddress = async () => {
		const owner = $userPQ.currentUserHash;
		if (ownerAddressOf?.owner !== owner) ownerAddressOf = { owner, address: alertWallet(await ownerKey()) };
		return ownerAddressOf.address;
	};

	let chain = null;
	/** One chain client for this deployment, made on first use. */
	const chainOf = () => (chain ??= new RecoveryChain(deployment));

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
	/** The candidates that can be picked: agreed, with the meta-address they agreed under. */
	const pickable = computed(() => candidates.value.filter((c) => c.status === 'agreed' && c.metaAddress));
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
		const chain = chainOf();
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

	/** Runs `fn(locked)` under the account's run lock, if this tab can take it now. */
	const withRunLock = (owner, fn) => {
		const lm = locks();
		if (!lm?.request) return fn(true);
		return lm.request(runLockName(owner), { mode: 'exclusive', ifAvailable: true }, (lock) => fn(!!lock));
	};

	/**
	 * What the run needs from outside, each refusing once another account is
	 * signed in: nothing of one account is written or signed under another.
	 * Every save, and the publication and registration before them, first
	 * check the slot still names this device as the run's: a run another
	 * device took over stops here without writing.
	 */
	const runDeps = ({ fee, runId }, owner) => {
		const chain = chainOf();
		const here = deviceLabel();
		const alive = () => {
			if ($userPQ.currentUserHash !== owner) throw new RunAbortedError();
		};
		const key = async () => {
			alive();
			const k = await ownerKey();
			alive();
			return k;
		};
		const ours = async (runId) => {
			const current = await readRun(owner);
			if (current && (current.runId !== runId || current.device !== here || current.step === 'discarded')) throw new RunTakenOverError();
			alive();
		};
		return {
			now: nowSec,
			save: async (next) => {
				await ours(next.runId);
				await save(next);
			},
			exportAccount: () => $userPQ.exportBackup(),
			publishVault: async (wrapKey, json) => {
				await ours(runId);
				const signSkey = fromBase64((await em().exportVaultKeys()).sign_skey);
				alive();
				return publishVault({ userHash: owner, signSkey, wrapKey, json });
			},
			register: async (fields) => {
				await ours(runId);
				const k = await key();
				const { id, body } = await signAddSecret(chain, k, fields);
				alive();
				const gateway = fee?.kind === 'self' ? directGateway(chain, k) : relayerGateway(fee?.url || deployment.relayerUrl);
				const { txHash } = await gateway.addSecret(body);
				return { id, txHash };
			},
			reshare: async ({ id, shares, threshold }) => {
				await ours(runId);
				const k = await key();
				const { body } = await signBound(chain, k, 'Reshare', id, { shares, threshold });
				alive();
				const gateway = fee?.kind === 'self' ? directGateway(chain, k) : relayerGateway(fee?.url || deployment.relayerUrl);
				return gateway.reshare(body);
			},
			secretIdOf,
			readVersion: async (id) => {
				const secret = await chain.readSecret(id);
				return secret ? Number(secret.version) : null;
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			deposit: async (node, d) => depositShare(node, d, await key()),
			sendShare: async (guardian, part) => {
				alive();
				return $dialogs.sendMessage(guardian, [part]);
			},
			secretRefOf: (id) => secretRefOf(deployment, id),
		};
	};

	/**
	 * Drives the account's run, under its lock. `prepare(latest, write)` gets
	 * the run as the slot holds it now — never a copy this tab kept — and
	 * returns the run to advance (writing any change first), or null; what it
	 * throws is the caller's. Resolves to 'busy' when another tab of this
	 * device holds the lock, else once the run stops; why it stopped lands in
	 * `stopped`.
	 */
	const drive = (prepare) => {
		const owner = $userPQ.currentUserHash;
		return withRunLock(owner, async (locked) => {
			if (!locked) {
				heldElsewhere.value = true;
				return 'busy';
			}
			heldElsewhere.value = false;
			const write = async (next) => {
				if ($userPQ.currentUserHash !== owner) throw new RunAbortedError();
				await save(next);
			};
			const from = await prepare(await readRun(owner), write);
			if (!from) return 'idle';
			running.value = true;
			stopped.value = null;
			try {
				if ($userPQ.currentUserHash === owner) run.value = from;
				const done = await advance(from, runDeps(from, owner), (r) => {
					if ($userPQ.currentUserHash === owner) run.value = r;
				});
				if ($userPQ.currentUserHash === owner) run.value = done;
			} catch (e) {
				if (e instanceof RunTakenOverError) run.value = await readRun(owner).catch(() => run.value);
				else if (e instanceof RunStoppedError) {
					stopped.value = e.reason;
					run.value = e.run;
				} else if (!(e instanceof RunInterruptedError)) stopped.value = errorMessage(e);
			} finally {
				running.value = false;
			}
			return 'driven';
		});
	};

	const refuseExisting = (r) => {
		if (r?.step === 'done') throw new Error('This account already has a backup. Changing it is a reshare.');
		if (r && r.step !== 'discarded') throw new Error('A backup is already being created.');
	};

	/**
	 * Starts a backup: step 1 is decided and saved before anything leaves this
	 * device. Resolves once it is saved; the run goes on in the background
	 * (`running`, `run`, `stopped`). Refused while the account has a backup
	 * or a run — one per account — and for settings or nodes the rules refuse:
	 * the screens are not the only way to this call, and what it registers
	 * cannot be taken back.
	 */
	const start = async ({ guardians, settings, nodes: chosen, fee, alerts, reshare = false }) => {
		if (!deployment) throw new Error('This app names no network to back up on.');
		// A reshare replaces a finished backup with its next version; a first backup needs none.
		const checkBase = (r) => {
			if (!reshare) return refuseExisting(r);
			if (r?.step !== 'done' || !r.secretId || !r.version) throw new Error('There is no finished backup to change.');
		};
		// This tab's copy can refuse at once; only the slot, read under the lock, can tell a reshare it may go ahead.
		if (!reshare) checkBase(run.value);
		const problems = [
			...settingsProblems(settings, guardians.length, chosen.length).map((p) => `${p.field}: ${p.reason}`),
			...setProblems(chosen, settings.nodeThreshold, guardians.map((g) => g.userHash)).map((p) => p.kind),
		];
		if (problems.length) throw new Error(`This backup cannot be created as set up (${problems.join(', ')}).`);
		const owner = await ownerAddress();
		let markSaved;
		const saved = new Promise((resolve) => (markSaved = resolve));
		const driving = drive(async (latest, write) => {
			checkBase(latest);
			const prepared = {
				...prepareRun({
					...(reshare ? { reshareOf: { secretId: latest.secretId, version: latest.version } } : {}),
					deployment: deploymentNamespace(deployment),
					owner,
					guardians,
					settings,
					nodes: chosen.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
					device: deviceLabel(),
					now: nowSec(),
				}),
				fee: fee ?? latest?.fee,
				alerts: alerts ?? latest?.alerts,
			};
			await write(prepared);
			markSaved();
			return prepared;
		});
		if ((await Promise.race([saved.then(() => 'saved'), driving])) === 'busy') throw new Error('A backup is being created in another tab.');
	};

	/** Continues the run from its saved step, when this device runs it. */
	const resume = () => drive(async (latest) => (unfinished(latest) && latest.device === deviceLabel() ? latest : null));

	/** Finishes without the nodes still pending, when the rest reach the node threshold. */
	const finishWithoutPendingNodes = () =>
		drive(async (latest, write) => {
			if (!latest || latest.device !== deviceLabel()) return null;
			const next = skipPendingNodes(latest);
			await write(next);
			return next;
		});

	/** Whether `r` is another device's run that has not moved for long enough to be continued here. */
	const takeoverable = (r, now) => unfinished(r) && r.device !== deviceLabel() && now - r.updatedAt > TAKEOVER_AFTER_SEC;
	const canTakeOver = computed(() => takeoverable(run.value, clock.value));

	/** Continues on this device a run another device stopped moving (it may be lost). */
	const takeOver = () =>
		drive(async (latest, write) => {
			if (!takeoverable(latest, nowSec())) throw new Error('This backup is still moving on another device.');
			const next = { ...latest, device: deviceLabel(), updatedAt: nowSec() };
			await write(next);
			return next;
		});

	/** Drops a run that has not reached the chain. */
	const discard = async () => {
		const owner = $userPQ.currentUserHash;
		await withRunLock(owner, async (locked) => {
			if (!locked) throw new Error('This backup is being created in another tab.');
			const latest = await readRun(owner);
			if (!latest || !canDiscard(latest)) throw new Error('This backup already exists on the network.');
			await save({ ...latest, step: 'discarded' });
		});
	};

	/** Records the alert channels set up once the backup exists, so its card stops warning. */
	const setAlerts = async (alerts) => {
		if (run.value?.step !== 'done') throw new Error('Alerts are recorded on a finished backup.');
		await save({ ...run.value, alerts });
	};

	// --- Changing a finished backup (plan § 7.4, Controls) ----------------------

	const finished = () => {
		const r = run.value;
		if (r?.step !== 'done' || !r.secretId) throw new Error('There is no finished backup.');
		if (r.revokedAt) throw new Error('This backup was revoked.');
		return r;
	};
	const gatewayFor = (r, k) => (r.fee?.kind === 'self' ? directGateway(chainOf(), k) : relayerGateway(r.fee?.url || deployment.relayerUrl));

	/** Changes the waiting period and the time to finish, on chain, then in the record. */
	const setPolicy = async ({ delaySec, windowSec }) => {
		const r = finished();
		const bad = settingsProblems({ ...r.settings, delaySec, windowSec }, r.guardians.length, r.nodes.length).filter((p) => p.field === 'delaySec' || p.field === 'windowSec');
		if (bad.length) throw new Error(`These times are out of bounds (${bad.map((p) => p.field).join(', ')}).`);
		const k = await ownerKey();
		const { body } = await signBound(chainOf(), k, 'SetRecoveryPolicy', r.secretId, { recoveryDelay: BigInt(delaySec), recoveryWindow: BigInt(windowSec) });
		await gatewayFor(r, k).setRecoveryPolicy(body);
		await save({ ...r, settings: { ...r.settings, delaySec, windowSec } });
	};

	/** Revokes the backup for good: no recovery can ever use it (pq_recovery_shares § Dying). */
	const revoke = async () => {
		const r = finished();
		const k = await ownerKey();
		const { body } = await signBound(chainOf(), k, 'RevokeSecret', r.secretId, {});
		await gatewayFor(r, k).revokeSecret(body);
		await save({ ...r, revokedAt: nowSec() });
	};

	/**
	 * Hands one spare piece to a guardian already in the backup: a second index
	 * of the same split, custody only — a spare never makes anyone a guardian
	 * (pq_recovery_shares § Spares). It leaves the record once sent.
	 */
	const giveSpare = async (guardianHash) => {
		const r = finished();
		if (!r.guardians.some((g) => g.userHash === guardianHash)) throw new Error('A spare goes only to a guardian of this backup.');
		const i = r.shares.findIndex((s, at) => at >= r.guardians.length && s);
		if (i < 0) throw new Error('No spare pieces are left.');
		const messageId = await $dialogs.sendMessage(guardianHash, [sharePartOf(r, i, secretRefOf(deployment, r.secretId), nowSec())]);
		const shares = [...r.shares];
		shares[i] = null;
		await save({ ...r, shares, sparesGiven: { ...(r.sparesGiven ?? {}), [i + 1]: { guardian: guardianHash, messageId } } });
	};

	const removeSubscription = async (id) => unsubscribe(alertsBase(), await ownerKey(), id);
	const history = async () => (alertsBase() ? alertHistory(alertsBase(), await ownerKey()) : []);

	/** Whether this tab of this device is the one to run the backup (another only shows its progress). */
	const runsHere = computed(() => !!run.value && run.value.device === deviceLabel() && !heldElsewhere.value);

	return {
		deployment,
		run,
		loaded,
		running,
		stopped,
		load,
		refreshRun,
		follow,
		unfollow,
		candidates,
		pickable,
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
		setAlerts,
		setPolicy,
		revoke,
		giveSpare,
		removeSubscription,
		history,
		runsHere,
		heldElsewhere,
		canTakeOver,
		takeOver,
	};
});
