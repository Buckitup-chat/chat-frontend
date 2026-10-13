// The account's community backup (plan § 7.2, § 7.4): who can be a guardian,
// the nodes it knows, the fee, the alert channels, the run that creates the
// backup and the reshare that makes its next version — kept in one
// user_storage slot (backupRun.BackupSlot), so another device shows the same
// progress and never starts a second one — and the owner's controls over it.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { formatEther } from 'ethers';
import { v7 as uuidv7 } from 'uuid';
import { userPQStore } from '@/store/userPQ.store';
import errorMessage from '@/utils/errorMessage';
import { useDialogsStore } from '@/store/dialogs.store';
import { useRecoveryInvitesStore } from '@/store/recoveryInvites.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { RecoveryChain } from '@/lib/recovery/chain';
import { maybeRecoveryDeployment, deploymentNamespace, secretIdOf, secretRefOf } from '@/lib/recovery/deployments';
import { gatewayOf } from '@/lib/recovery/gateway';
import { ownerKeyOf } from '@/lib/recovery/evmSign';
import { signAddSecret, signBound } from '@/lib/recovery/typedData';
import { depositShare, holdingOf } from '@/lib/recovery/nodeClient';
import { liveInviteId } from '@/lib/recovery/inviteThread';
import { knownNodes, checkNode, syncedServerNode } from '@/lib/recovery/nodeDirectory';
import { RunInterruptedError, RunAbortedError, RunTakenOverError, RunStoppedError, advance, prepareRun, skipPendingNodes, canDiscard, sharePartOf, activeRun, unfinished, promoteReshare } from '@/lib/recovery/backupRun';
import { policyProblems, settingsProblems } from '@/lib/recovery/backupPlan';
import { setProblems } from '@/lib/recovery/nodeChoice';
import { listSubscriptions, subscribeWebhook, telegramReply, alertWallet, unsubscribe, alertHistory } from '@/lib/recovery/alerts';
import { LOST_DELIVERIES, isReportOn, receiptOf, sentSharesOf } from '@/lib/recovery/receipts';

export const BACKUP_SLOT = 'recovery_backup';
export const NODES_SLOT = 'recovery_nodes';
const DEVICE_KEY = 'buckitup:device-label';
/** How often a run driven elsewhere — another device or tab — is read again while a screen follows it. */
const FOLLOW_MS = 15_000;
/** A guardian's word read this recently is not read again from their dialog. */
const RECEIPT_FRESH_MS = 2 * 60_000;
/** How long one check of the nodes' holdings may take, all nodes at once. */
const HOLDINGS_BUDGET_MS = 20_000;
/** The nodes' holdings checked this recently are not checked again, unless asked to. */
const HOLDINGS_FRESH_MS = 3 * 60_000;
/** Guardian dialogs read at once for their receipts. */
const RECEIPT_READS_AT_ONCE = 3;
/** A run another device has not moved for this long may be continued here: that device may be lost. */
export const TAKEOVER_AFTER_SEC = 10 * 60;
/** One tab of one device drives an account's run at a time. */
export const runLockName = (owner) => `buckitup:backup-run:${owner}`;
/** One write onto the finished backup's record at a time, on this device: each reads the record and writes it whole. */
export const recordLockName = (owner) => `buckitup:backup-record:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);

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

export const useRecoveryBackupStore = defineStore('recoveryBackup', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const $invites = useRecoveryInvitesStore();

	const deployment = maybeRecoveryDeployment();

	/** The backup's record: the first run until it is done, then the finished backup; null before the first backup. */
	const run = ref(null);
	/** The next version of a finished backup while it is being made; it takes `run`'s place once done. */
	const reshare = ref(null);
	/** The run being made, if any — a reshare or the first run — else the record: what progress shows. */
	const current = computed(() => activeRun({ run: run.value, reshare: reshare.value }) ?? run.value);
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
		reshare.value = null;
		savedNodeUrls.value = [];
		loaded.value = false;
		stopped.value = null;
		heldElsewhere.value = false;
		heard.value = { runId: null, byGuardian: {} };
		lastHeard.clear();
		subs.value = [];
		subsFresh = false;
		holdings.value = { runId: null, byNode: {}, at: 0 };
	});

	const em = () => EncryptionManagerPQ.getInstance();

	const locks = () => (typeof navigator !== 'undefined' ? navigator.locks : undefined);
	/** Whether another tab of this device drives the run now. */
	const checkHeld = async (owner) => {
		const held = locks()?.query ? ((await locks().query()).held ?? []) : [];
		if ($userPQ.currentUserHash === owner) heldElsewhere.value = !running.value && held.some((l) => l.name === runLockName(owner));
	};

	/** `owner`'s backup slot as it is now ({ run, reshare }); throws RunAbortedError once another account is signed in. */
	const readSlot = async (owner) => {
		const backup = await em().loadSlotJson(BACKUP_SLOT);
		if ($userPQ.currentUserHash !== owner) throw new RunAbortedError();
		return { run: backup?.run ?? null, reshare: backup?.reshare ?? null };
	};
	const show = (slot) => {
		run.value = slot.run;
		reshare.value = slot.reshare;
	};

	/** Reads the backup's slot, its nodes and the invitations; calls for the same account while a read runs share it. */
	let loading = null;
	const load = () => {
		const owner = $userPQ.currentUserHash;
		if (loading?.owner === owner) return loading.promise;
		const promise = (async () => {
			const [backup, nodes] = await Promise.all([em().loadSlotJson(BACKUP_SLOT), em().loadSlotJson(NODES_SLOT), $invites.load({ refresh: true }), checkHeld(owner)]);
			if ($userPQ.currentUserHash !== owner) return;
			clock.value = nowSec();
			if (!running.value) show({ run: backup?.run ?? null, reshare: backup?.reshare ?? null });
			savedNodeUrls.value = nodes?.urls ?? [];
			loaded.value = true;
		})().finally(() => {
			if (loading?.promise === promise) loading = null;
		});
		loading = { owner, promise };
		return promise;
	};

	/** Only the run's slot, for following a run another device or tab drives. */
	const refreshRun = async () => {
		const owner = $userPQ.currentUserHash;
		const [latest] = await Promise.all([readSlot(owner).catch(() => undefined), checkHeld(owner)]);
		clock.value = nowSec();
		if (latest === undefined || running.value) return;
		show(latest);
	};

	// Screens that show an unfinished run follow it; nothing is read while none does.
	let followers = 0;
	let followTimer = null;
	const follow = () => {
		followers += 1;
		followTimer ??= setInterval(() => {
			clock.value = nowSec();
			if (running.value || !activeRun({ run: run.value, reshare: reshare.value })) return;
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

	const ownerKey = () => ownerKeyOf(em());
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
	/** Checks the nodes this account knows; calls made while a check runs share it. */
	let nodesReading = null;
	const refreshNodes = () =>
		(nodesReading ??= (async () => {
			if (!deployment) return;
			const out = await knownNodes(nodeUrls(), directoryDeps());
			nodes.value = out.nodes;
			refusedNodes.value = out.refused;
		})().finally(() => {
			nodesReading = null;
		}));

	/**
	 * Whether each node of the backup still holds its part (pq_recovery_services
	 * § Choosing nodes, "Holdings are watched"), by node id: 'holds' at the
	 * backup's version, 'lost' when the node answers with none or another
	 * version — a node up but wiped holds nothing — and 'unreachable' when
	 * nothing answers in time, which is not the same as holding nothing. For
	 * one record: another starts from nothing.
	 */
	const holdings = ref({ runId: null, byNode: {}, at: 0 });
	let holdingsReading = null;
	/**
	 * Checks the holdings again, unless they were checked for this record
	 * within HOLDINGS_FRESH_MS; `force` checks them anyway. A node holding a
	 * newer version holds: a reshare is under way, or done on another device.
	 * While a reshare is being made, a node without the version is
	 * 'changing' rather than lost — it may be taking the new one.
	 */
	const checkHoldings = ({ force = false } = {}) => {
		if (holdingsReading) return holdingsReading;
		const r = run.value;
		if (r?.step !== 'done' || r.revokedAt || !r.secretId) return Promise.resolve();
		if (!force && holdings.value.runId === r.runId && Date.now() - holdings.value.at < HOLDINGS_FRESH_MS) return Promise.resolve();
		const owner = $userPQ.currentUserHash;
		holdingsReading = (async () => {
			const signal = AbortSignal.timeout(HOLDINGS_BUDGET_MS);
			const one = async (n) => {
				try {
					const version = await holdingOf(n, r.secretId, { signal, timeoutMs: HOLDINGS_BUDGET_MS / 2 });
					if (version !== null && version >= r.version) return [n.id, 'holds'];
					return [n.id, unfinished(reshare.value) ? 'changing' : 'lost'];
				} catch {
					return [n.id, 'unreachable'];
				}
			};
			const byNode = Object.fromEntries(await Promise.all(r.nodes.filter((n) => !r.skippedNodes.includes(n.id)).map(one)));
			if ($userPQ.currentUserHash === owner) holdings.value = { runId: r.runId, byNode, at: Date.now() };
		})().finally(() => {
			holdingsReading = null;
		});
		return holdingsReading;
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

	/** The account's alert channels as last listed (kinds only), and whether that list still stands. */
	const subs = ref([]);
	let subsFresh = false;
	let subsReading = null;
	/** The channels a finished backup's record should name for `list`: the app, and each kind listed. */
	const channelsOf = (list) => ['app', ...['telegram', 'webhook'].filter((k) => list.some((x) => x.kind === k))];
	/**
	 * Writes the channels `list` names onto the finished backup's record, as
	 * the slot holds it under the lock, when they differ: the server's list is
	 * the truth, and a write that failed before is made good here.
	 */
	const syncAlerts = async (list) => {
		const r = run.value;
		if (r?.step !== 'done' || r.revokedAt) return;
		const channels = channelsOf(list);
		const same = (rec) => channels.join() === (rec.alerts?.channels ?? ['app']).join();
		// This tab's copy settles the common case; a write is decided on the record as the slot holds it.
		if (same(r)) return;
		await patchRecord($userPQ.currentUserHash, (record) => (same(record) ? null : { alerts: { channels, skipped: false } }));
	};
	const readSubs = async () => {
		const owner = $userPQ.currentUserHash;
		const list = alertsBase() ? await listSubscriptions(alertsBase(), await ownerKey()) : [];
		if ($userPQ.currentUserHash !== owner) return list;
		subs.value = list;
		subsFresh = true;
		await syncAlerts(list).catch((e) => console.warn('[recovery] the alert channels could not be recorded:', e));
		return list;
	};
	/**
	 * The account's alert channels: the list in hand while it stands, else
	 * read from the server. `refresh` reads it again — after the reads under
	 * way, so it sees what changed since they started.
	 */
	const subscriptions = ({ refresh = false } = {}) => {
		if (!refresh && subsFresh) return Promise.resolve(subs.value);
		if (!refresh && subsReading) return subsReading;
		const read = (subsReading ?? Promise.resolve()).catch(() => undefined).then(readSubs);
		const pending = read.finally(() => {
			if (subsReading === pending) subsReading = null;
		});
		subsReading = pending;
		return read;
	};
	/** The next read of the channels goes to the server (a screen opened anew). */
	const staleSubscriptions = () => {
		subsFresh = false;
	};
	const addWebhook = async (url) => {
		const out = await subscribeWebhook(alertsBase(), await ownerKey(), url);
		await subscriptions({ refresh: true }).catch((e) => console.warn('[recovery] alert channels could not be read:', e));
		return out;
	};
	const telegramLine = async (botText) => telegramReply(botText, await ownerKey());
	const walletForBot = async () => alertWallet(await ownerKey());

	// --- What the guardians say ------------------------------------------

	/** The guardians' word on the run's pieces (receipts.ts), by userHash; for one run, so another starts from nothing. */
	const heard = ref({ runId: null, byGuardian: {} });
	const receiptDetails = computed(() => (heard.value.runId && heard.value.runId === run.value?.runId ? heard.value.byGuardian : {}));
	/** userHash → Delivery: what backupFlow.guardianDelivery and healthView take. */
	const receipts = computed(() => Object.fromEntries(Object.entries(receiptDetails.value).map(([g, r]) => [g, r.state])));
	/** When each guardian's word was last taken, by `<runId>|<guardian>`: a read this fresh is not made again. */
	const lastHeard = new Map();
	const hear = (runId, guardian, receipt, { read = false } = {}) => {
		// A read of the dialog counts as heard whatever it found; a page's
		// messages only when they said something, so the background read is
		// still free to learn `delivered`.
		if (read || receipt) lastHeard.set(`${runId}|${guardian}`, Date.now());
		if (!receipt) return;
		const byGuardian = heard.value.runId === runId ? heard.value.byGuardian : {};
		const prev = byGuardian[guardian];
		if (prev && prev.state === receipt.state && prev.detail === receipt.detail) return;
		heard.value = { runId, byGuardian: { ...byGuardian, [guardian]: receipt } };
	};

	/**
	 * Reads what each guardian the run sent a piece to has said about it, in
	 * their dialog, a few dialogs at a time: only the newest report on that
	 * piece is decrypted. A guardian heard from within RECEIPT_FRESH_MS — an
	 * open dialog feeds its word in as it comes — is not read again, and a
	 * dialog that cannot be read now keeps what was heard before.
	 */
	let reading = null;
	const refreshReceipts = () => {
		if (reading) return reading;
		const owner = $userPQ.currentUserHash;
		reading = (async () => {
			if (!loaded.value) await load();
			const current = run.value;
			const sent = sentSharesOf(current);
			const due = Object.keys(sent).filter((g) => Date.now() - (lastHeard.get(`${current.runId}|${g}`) ?? 0) >= RECEIPT_FRESH_MS);
			const readOne = async (guardian) => {
				const read = await $dialogs.readPeerParts(guardian, ['recovery_holding'], {
					deliveredOf: [sent[guardian].messageId],
					newestMatch: isReportOn(sent[guardian]),
					after: sent[guardian].messageId,
				});
				if (read && $userPQ.currentUserHash === owner) hear(current.runId, guardian, receiptOf(guardian, sent[guardian], read), { read: true });
			};
			// A few dialogs at a time: each read opens its own shape.
			for (let i = 0; i < due.length; i += RECEIPT_READS_AT_ONCE) {
				await Promise.all(due.slice(i, i + RECEIPT_READS_AT_ONCE).map(readOne));
				if ($userPQ.currentUserHash !== owner) return;
			}
		})().finally(() => {
			reading = null;
		});
		return reading;
	};

	/**
	 * What an open dialog with `guardian` shows of their word on the run's
	 * piece ({ senderHash, parts } in dialog order): read from the page,
	 * without a second read of the dialog.
	 */
	const noteGuardianMessages = (guardian, messages) => {
		const current = run.value;
		const sent = sentSharesOf(current)[guardian];
		if (sent) hear(current.runId, guardian, receiptOf(guardian, sent, { messages, delivered: [] }));
	};

	// --- The run -------------------------------------------------------------

	/** Writes `patch` into the backup slot and shows the slot as the server took it. */
	const writeSlot = async (patch) => {
		const accepted = await em().patchSlotJson(BACKUP_SLOT, patch);
		show({
			run: accepted ? (accepted.run ?? null) : 'run' in patch ? patch.run : run.value,
			reshare: accepted ? (accepted.reshare ?? null) : 'reshare' in patch ? patch.reshare : reshare.value,
		});
	};
	/**
	 * Writes a run where it belongs: a reshare beside the record until it is
	 * done, then merged into the record as the slot holds it now
	 * (backupRun.promoteReshare) — never over a revoked one, which it leaves
	 * beside it.
	 */
	const save = async (next) => {
		if (!next.reshareOf) return writeSlot({ run: next });
		if (next.step !== 'done') return writeSlot({ reshare: next });
		const owner = $userPQ.currentUserHash;
		return withRecordLock(owner, async () => {
			const record = (await readSlot(owner)).run;
			if (!record || record.revokedAt) return writeSlot({ reshare: next });
			return writeSlot({ run: promoteReshare(record, next), reshare: null });
		});
	};

	/** Runs `fn` holding the record's lock, waiting for it: a record write is short. */
	const withRecordLock = (owner, fn) => {
		const lm = locks();
		return lm?.request ? lm.request(recordLockName(owner), { mode: 'exclusive' }, fn) : fn();
	};
	/**
	 * Writes `changes(record)` onto the finished backup's record as the slot
	 * holds it, under the record's lock — never the run's, so a change being
	 * made does not hold it up; `changes` returning null writes nothing.
	 * Throws RunAbortedError once another account is signed in.
	 */
	const patchRecord = (owner, changes) =>
		withRecordLock(owner, async () => {
			const fresh = finishedOf((await readSlot(owner)).run);
			if ($userPQ.currentUserHash !== owner) throw new RunAbortedError();
			const c = changes(fresh);
			if (c) await writeSlot({ run: { ...fresh, ...c } });
		});
	/** Shows a run being made where it belongs, without writing it; a done reshare is shown by the write that promoted it. */
	const place = (r) => {
		if (!r?.reshareOf) run.value = r;
		else if (r.step !== 'done') reshare.value = r;
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
		// The run being made, as the slot holds it, must still be this one, on this device.
		const ours = async (runId) => {
			const active = activeRun(await readSlot(owner));
			if (!active || active.runId !== runId || active.device !== here) throw new RunTakenOverError();
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
				return em().publishRecoveryVault(wrapKey, json);
			},
			retireVaults: async (keep) => {
				await ours(runId);
				await em().retireRecoveryVaults({ keep });
			},
			register: async (fields) => {
				await ours(runId);
				const k = await key();
				const { id, body } = await signAddSecret(chain, k, fields);
				alive();
				const { txHash } = await gatewayOf(chain, fee, k, deployment.relayerUrl).addSecret(body);
				return { id, txHash };
			},
			reshare: async ({ id, shares, threshold }) => {
				await ours(runId);
				const k = await key();
				const { body } = await signBound(chain, k, 'Reshare', id, { shares, threshold });
				alive();
				return gatewayOf(chain, fee, k, deployment.relayerUrl).reshare(body);
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
	 * Drives the account's run being made, under its lock. `prepare(slot,
	 * write)` gets the slot as it is now ({ run, reshare }) — never a copy this
	 * tab kept — and returns the run to advance (writing any change first), or null; what it
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
			const from = await prepare(await readSlot(owner), write);
			if (!from) return 'idle';
			running.value = true;
			stopped.value = null;
			try {
				if ($userPQ.currentUserHash === owner) place(from);
				const done = await advance(from, runDeps(from, owner), (r) => {
					if ($userPQ.currentUserHash === owner) place(r);
				});
				if ($userPQ.currentUserHash === owner) place(done);
			} catch (e) {
				if (e instanceof RunTakenOverError) await readSlot(owner).then(show, () => undefined);
				else if (e instanceof RunStoppedError) {
					stopped.value = e.reason;
					place(e.run);
				} else if (!(e instanceof RunInterruptedError)) stopped.value = errorMessage(e);
			} finally {
				running.value = false;
			}
			return 'driven';
		});
	};

	/** A first backup is refused while the account has one, unless it was revoked: a revoked backup protects nothing, and a new one takes its place. */
	const refuseExisting = (r) => {
		if (r?.step === 'done' && !r.revokedAt) throw new Error('This account already has a backup. Changing it is a reshare.');
		if (r && r.step !== 'done' && r.step !== 'discarded') throw new Error('A backup is already being created.');
	};

	/** `r` if it is a finished backup that can still be changed; throws otherwise. */
	const finishedOf = (r) => {
		if (r?.step !== 'done' || !r.secretId || r.version == null) throw new Error('There is no finished backup.');
		if (r.revokedAt) throw new Error('This backup was revoked.');
		return r;
	};

	/**
	 * Starts a backup — or, with `reshare`, the next version of the finished
	 * one: step 1 is decided and saved before anything leaves this device.
	 * Resolves once it is saved; the run goes on in the background (`running`,
	 * `current`, `stopped`). A first backup is refused while the account has a
	 * backup or a run — one per account — and a reshare unless the backup is
	 * finished and not revoked, with no other reshare being made; both are
	 * refused for settings or nodes the rules refuse: the screens are not the
	 * only way to this call, and what it registers cannot be taken back. A
	 * reshare is kept beside the record, which stays as it is until the
	 * reshare is done.
	 */
	const start = async ({ guardians, settings, nodes: chosen, fee, alerts, reshare: resharing = false }) => {
		if (!deployment) throw new Error('This app names no network to back up on.');
		// This tab's copy can refuse a first backup at once; a reshare is decided on the slot, under the lock.
		if (!resharing) refuseExisting(run.value);
		// A reshare keeps the backup's waiting period and time to finish (reshareWithSig does not set them; setPolicy does).
		const policy = (p) => !resharing || (p.field !== 'delaySec' && p.field !== 'windowSec');
		const problems = [
			...settingsProblems(settings, guardians.length, chosen.length).filter(policy).map((p) => `${p.field}: ${p.reason}`),
			...setProblems(chosen, settings.nodeThreshold, guardians.map((g) => g.userHash)).map((p) => p.kind),
		];
		if (problems.length) throw new Error(`This backup cannot be created as set up (${problems.join(', ')}).`);
		const owner = await ownerAddress();
		let markSaved;
		const saved = new Promise((resolve) => (markSaved = resolve));
		const driving = drive(async (slot, write) => {
			let reshareOf;
			let policy = {};
			if (resharing) {
				const base = finishedOf(slot.run);
				if (unfinished(slot.reshare)) throw new Error('The backup is already being reshared.');
				reshareOf = { secretId: base.secretId, version: base.version };
				policy = { delaySec: base.settings.delaySec, windowSec: base.settings.windowSec };
			} else refuseExisting(slot.run);
			const prepared = {
				...prepareRun({
					...(reshareOf ? { reshareOf } : {}),
					deployment: deploymentNamespace(deployment),
					owner,
					guardians,
					settings: { ...settings, ...policy },
					nodes: chosen.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
					device: deviceLabel(),
					now: nowSec(),
				}),
				fee: fee ?? slot.run?.fee,
				alerts: alerts ?? slot.run?.alerts,
			};
			await write(prepared);
			markSaved();
			return prepared;
		});
		if ((await Promise.race([saved.then(() => 'saved'), driving])) === 'busy') throw new Error('A backup is being created in another tab.');
	};

	/** Continues the run being made from its saved step, when this device runs it. */
	const resume = () =>
		drive(async (slot) => {
			const active = activeRun(slot);
			return active && active.device === deviceLabel() ? active : null;
		});

	/** Finishes without the nodes still pending, when the rest reach the node threshold. */
	const finishWithoutPendingNodes = () =>
		drive(async (slot, write) => {
			const active = activeRun(slot);
			if (!active || active.device !== deviceLabel()) return null;
			const next = skipPendingNodes(active);
			await write(next);
			return next;
		});

	/** Whether `r` is another device's run that has not moved for long enough to be continued here. */
	const takeoverable = (r, now) => unfinished(r) && r.device !== deviceLabel() && now - r.updatedAt > TAKEOVER_AFTER_SEC;
	const canTakeOver = computed(() => takeoverable(current.value, clock.value));

	/** Continues on this device a run another device stopped moving (it may be lost). */
	const takeOver = () =>
		drive(async (slot, write) => {
			const active = activeRun(slot);
			if (!takeoverable(active, nowSec())) throw new Error('This backup is still moving on another device.');
			const next = { ...active, device: deviceLabel(), updatedAt: nowSec() };
			await write(next);
			return next;
		});

	/** Drops the run being made while it has not reached the chain; a reshare goes, and the backup it would replace stays. */
	const discard = async () => {
		const owner = $userPQ.currentUserHash;
		await withRunLock(owner, async (locked) => {
			if (!locked) throw new Error('This backup is being created in another tab.');
			const active = activeRun(await readSlot(owner));
			if (!active || !canDiscard(active)) throw new Error('This backup already exists on the network.');
			await writeSlot(active.reshareOf ? { reshare: null } : { run: { ...active, step: 'discarded' } });
		});
	};

	// --- Changing a finished backup (plan § 7.4, Controls) ----------------------

	/**
	 * Runs `fn(record, act)` on the finished backup as the slot holds it now,
	 * under the run lock: two tabs never act on one record at once, and none
	 * on a copy it kept from before another's change. Refused while a reshare
	 * is being made. `act.alive()` says whether the
	 * account is still the one signed in — after an await, nothing is sent or
	 * written once it is not, and the action ends quietly — and
	 * `act.patch(changes)` writes `changes(record)` onto the record as the slot
	 * holds it at that moment (patchRecord): the fields an action changes,
	 * never a snapshot.
	 */
	const onFinished = (fn) => {
		const owner = $userPQ.currentUserHash;
		const alive = () => $userPQ.currentUserHash === owner;
		return withRunLock(owner, async (locked) => {
			if (!locked) throw new Error('The backup is being changed in another tab.');
			try {
				const slot = await readSlot(owner);
				const record = finishedOf(slot.run);
				if (unfinished(slot.reshare)) throw new Error('The backup is being changed: finish or discard the change first.');
				const patch = (changes) => patchRecord(owner, changes);
				return await fn(record, { alive, patch });
			} catch (e) {
				if (e instanceof RunAbortedError) return undefined;
				throw e;
			}
		});
	};

	/**
	 * An owner action signed over the backup's secret (typedData.signBound
	 * `type`) and sent the way the backup pays (gateway `method`), then
	 * recorded: `fields(record)` is what is signed — it may refuse — and
	 * `changes(record)` what the record gains.
	 */
	const ownerAct = (type, method, fields, changes) =>
		onFinished(async (r, { alive, patch }) => {
			const signed = fields(r);
			const k = await ownerKey();
			if (!alive()) return;
			const c = chainOf();
			const { body } = await signBound(c, k, type, r.secretId, signed);
			if (!alive()) return;
			await gatewayOf(c, r.fee, k, deployment.relayerUrl)[method](body);
			await patch(changes);
		});

	/** Records the alert channels set up once the backup exists, so its card stops warning. */
	const setAlerts = async (alerts) => {
		if (run.value?.step !== 'done') throw new Error('Alerts are recorded on a finished backup.');
		// Alerts are not the run's: a change being made does not hold them up.
		const owner = $userPQ.currentUserHash;
		try {
			await patchRecord(owner, () => ({ alerts }));
		} catch (e) {
			if (!(e instanceof RunAbortedError)) throw e;
		}
	};

	/** Changes the waiting period and the time to finish, on chain, then in the record. */
	const setPolicy = ({ delaySec, windowSec }) =>
		ownerAct(
			'SetRecoveryPolicy',
			'setRecoveryPolicy',
			(r) => {
				const bad = policyProblems(r.settings, delaySec, windowSec, r.guardians.length, r.nodes.length);
				if (bad.length) throw new Error(`These times are out of bounds (${bad.map((p) => p.field).join(', ')}).`);
				return { recoveryDelay: BigInt(delaySec), recoveryWindow: BigInt(windowSec) };
			},
			(r) => ({ settings: { ...r.settings, delaySec, windowSec } }),
		);

	/** Revokes the backup for good: no recovery can ever use it (pq_recovery_shares § Dying). */
	const revoke = async () => {
		const owner = $userPQ.currentUserHash;
		await ownerAct('RevokeSecret', 'revokeSecret', () => ({}), () => ({ revokedAt: nowSec() }));
		// Revoked, the vaults open nothing that matters on chain; retired, nothing is left to read at all.
		if ($userPQ.currentUserHash === owner && run.value?.revokedAt) await em().retireRecoveryVaults();
	};

	/**
	 * Hands one spare piece to a guardian already in the backup: a second index
	 * of the same split, custody only — a spare never makes anyone a guardian
	 * (pq_recovery_shares § Spares). It leaves the record once sent; the record
	 * read under the lock is what says which spares are left.
	 */
	const giveSpare = (guardianHash) =>
		onFinished(async (r, { alive, patch }) => {
			if (!r.guardians.some((g) => g.userHash === guardianHash)) throw new Error('A spare goes only to a guardian of this backup.');
			const word = heard.value.runId === r.runId ? heard.value.byGuardian[guardianHash]?.state : null;
			if (LOST_DELIVERIES.includes(word)) throw new Error('This guardian no longer keeps their piece: a spare goes to one who does.');
			const i = r.shares.findIndex((s, at) => at >= r.guardians.length && s);
			if (i < 0) throw new Error('No spare pieces are left.');
			const part = sharePartOf(r, i, secretRefOf(deployment, r.secretId), nowSec());
			if (!alive()) return;
			const messageId = await $dialogs.sendMessage(guardianHash, [part]);
			await patch((fresh) => ({
				shares: fresh.shares.map((s, at) => (at === i ? null : s)),
				sparesGiven: { ...(fresh.sparesGiven ?? {}), [i + 1]: { guardian: guardianHash, messageId } },
			}));
		});

	const noAlertsServer = () => new Error('This network has no notification server.');
	/**
	 * Deletes alert channel `id`, then lists the channels again and records
	 * what is left on the finished backup (syncAlerts), so its card warns once
	 * none outside the app is. A record that could not be written then is
	 * made good by the next list.
	 */
	const removeSubscription = async (id) => {
		if (!alertsBase()) throw noAlertsServer();
		await unsubscribe(alertsBase(), await ownerKey(), id);
		return subscriptions({ refresh: true });
	};
	const history = async () => (alertsBase() ? alertHistory(alertsBase(), await ownerKey()) : []);

	/** Whether this tab of this device is the one to run the backup (another only shows its progress). */
	const runsHere = computed(() => !!current.value && current.value.device === deviceLabel() && !heldElsewhere.value);

	return {
		deployment,
		run,
		reshare,
		current,
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
		holdings,
		checkHoldings,
		addNodeUrl,
		selfPayQuote,
		subs,
		subscriptions,
		staleSubscriptions,
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
		receipts,
		receiptDetails,
		refreshReceipts,
		noteGuardianMessages,
	};
});
