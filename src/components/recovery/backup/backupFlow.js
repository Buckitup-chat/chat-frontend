// What the community backup screens share (docs/design-recovery-backup.md):
// the setup being drafted — guardians, settings, nodes, fee, alerts — and the
// wording the card, the progress screen and the summary all say the same way.
// The rules themselves live in src/lib/recovery; this only asks them.
import { computed, reactive, watch } from 'vue';
import { defaultSettings, settingsProblems, neededGuardians, relayerCanTake, healthOf, durationText, plural } from '@/lib/recovery/backupPlan';
import { defaultNodeSet, setProblems, operatorOf, BUCKITUP } from '@/lib/recovery/nodeChoice';
import { nodeHolds, unfinished } from '@/lib/recovery/backupRun';

export const DRAFT = Symbol('communityBackupDraft');
export const NAV = Symbol('communityBackupNav');

/** The six steps of a run, as the progress screen and the card name them. */
export const STEP_LABELS = [
	'Sealing your keys and cutting the pieces',
	'Saving the sealed copy',
	'Registering on the network',
	'Handing the node half to nodes',
	'Sending pieces to guardians',
	'Done',
];

export const SPARES_CAPTION = 'kept in your account — for an existing guardian, or a later reshare';

/** "0x7a3F…c91E". */
export const shortAddress = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

export const hostOf = (url) => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

/** An https address with a dotted host: what a service or a webhook is typed as. */
export const isHttpsUrl = (url) => /^https:\/\/[^\s/]+\.[^\s]+$/i.test(String(url ?? '').trim());

/** "3 days" → "3-day", as in "3-day wait". */
export const durationAdjective = (sec) => durationText(sec).replace(/s$/, '').replace(' ', '-');

/** A contract bound ({ min, max } seconds) as a caption: "10 minutes … 365 days". */
export const boundsText = (b, sep = ' … ') => `${durationText(b.min)}${sep}${durationText(b.max)}`;

/** A moment as the screens date it; `t` is unix seconds. "Oct 13, 2026", with `time` "Oct 13, 2026, 10:00 AM". */
export const dateText = (t, { time = false } = {}) =>
	new Date(t * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) });

/** "2 days ago", "5 minutes ago", "just now". */
export const agoText = (sec, now = Math.floor(Date.now() / 1000)) => {
	const d = Math.max(0, now - sec);
	if (d < 60) return 'just now';
	if (d < 3600) return `${plural(Math.floor(d / 60), 'minute')} ago`;
	if (d < 86400) return `${plural(Math.floor(d / 3600), 'hour')} ago`;
	return `${plural(Math.floor(d / 86400), 'day')} ago`;
};

// --- Names -----------------------------------------------------------------------

/** Who runs a node, as a person reads it: BuckitUp, a contact's name, you, or its address. */
export const nodeOwnerName = (descriptor, $userPQ) => {
	const operator = descriptor.operator;
	if (operatorOf(operator) === BUCKITUP) return 'BuckitUp';
	if ($userPQ?.currentUserHash && operator === $userPQ.currentUserHash) return 'You';
	return $userPQ?.contactsMap?.[operator]?.name || hostOf(descriptor.url);
};

/** A node of a backup's record ({ id, url }), named by its operator when this device knows it, else by its address. */
export const nodeRefName = (ref, known, $userPQ) => {
	const node = known?.find((n) => n.descriptor.id === ref.id);
	return node ? nodeOwnerName(node.descriptor, $userPQ) : hostOf(ref.url);
};

/** A guardian's name: as a candidate, else as a contact. */
export const guardianName = (userHash, candidates, $userPQ) =>
	candidates?.find((c) => c.userHash === userHash)?.name || $userPQ?.contactsMap?.[userHash]?.name || 'Guardian';

// --- Fee -----------------------------------------------------------------------------

/** The deployment's chain pays in ether. */
export const CURRENCY = 'ETH';

/** An ether amount at three significant digits: "0.84", "0.0215". */
export const amount = (eth) => {
	const n = Number(eth);
	if (!Number.isFinite(n)) return eth;
	return n === 0 ? '0' : n < 0.0001 ? '< 0.0001' : String(Number(n.toPrecision(3)));
};

const FEE_TEXT = {
	short: { buckitup: 'free', other: 'another service', self: 'paid from your address' },
	row: { buckitup: 'BuckitUp · free', other: 'another service', self: 'paid from your address' },
};
/** How the fee is paid, as the summary ('short') or a settings row ('row') says it. */
export const feeText = (choice, variant = 'short') => FEE_TEXT[variant][choice];

/** Why a fee choice cannot be used, or null; `quote` is the last self-pay quote, null while it is read. */
export const feeProblem = (choice, url, quote) => {
	if (choice === 'other' && !isHttpsUrl(url)) return 'Type the https address of the service that pays the fee.';
	if (choice === 'self') {
		if (!quote) return 'Reading the balance…';
		if (!quote.enough) return 'Balance is too low for the fee.';
	}
	return null;
};

// --- Alerts --------------------------------------------------------------------------

export const ALERT_NAMES = { app: 'app', telegram: 'Telegram', webhook: 'webhook' };
/** "app, Telegram"; as a title, "App · Telegram". */
export const alertsText = (channels = ['app'], { title = false } = {}) => {
	const names = channels.map((c) => ALERT_NAMES[c] ?? c);
	return title ? names.map((n) => n[0].toUpperCase() + n.slice(1)).join(' · ') : names.join(', ');
};
/** Whether a channel outside the app is on: the app alone can be lost with the phone. */
export const hasOutsideAlerts = (alerts) => !!alerts?.channels?.some((c) => c !== 'app');

// --- A finished backup -------------------------------------------------------------

/** A finished backup that still protects the account: not revoked. */
export const isLiveBackup = (run) => run?.step === 'done' && !run.revokedAt;

/** Whether a change of the finished backup (a reshare) is being made: the controls wait for it. */
export const changeInProgress = (store) => unfinished(store.reshare);
/** What a control says while a change is being made. */
export const FINISH_CHANGE_FIRST = 'A change to this backup is being made. Finish or discard the change first.';

// --- Delivery and health ----------------------------------------------------------

/**
 * Where guardian `userHash`'s piece stands (receipts.ts Delivery): what the
 * guardian said about it in their dialog, else what the run knows — 'sent'
 * or 'waiting'. `receipts` is the backup store's, by userHash.
 */
export const guardianDelivery = (run, userHash, receipts = {}) => receipts[userHash] ?? (run?.sent?.[userHash] ? 'sent' : 'waiting');

/** A piece's state in a list row. */
export const DELIVERY_WORDS = {
	waiting: 'waiting',
	sent: 'sent',
	delivered: 'delivered',
	stored: 'stored',
	problem: 'problem',
	given_back: 'given back',
	dropped: 'dropped',
};

/**
 * What the owner is told under a guardian whose piece no longer counts:
 * kept with a problem, given back or dropped — each a prompt to reshare (the
 * reshare itself is the roster's, plan § 7.4). Null for the other states.
 */
export const deliveryHint = (state, detail = '') => {
	const reshare = 'A reshare replaces this piece.';
	if (state === 'problem') return `${detail ? `They report: ${detail}.` : 'They report a problem with it.'} ${reshare}`;
	if (state === 'given_back') return `They gave it back. ${reshare}`;
	if (state === 'dropped') return `They no longer keep it${detail ? `: ${detail}` : ''}. ${reshare}`;
	return null;
};

/** A guardian's piece in the roster, as the owner reads it. */
export const ROSTER_TEXT = {
	stored: 'holds a piece',
	delivered: 'delivered',
	sent: 'sent',
	waiting: 'waiting for keys',
	problem: 'has a problem',
	given_back: 'gave it back',
	dropped: 'dropped it',
};

/** A piece in these states no longer counts: each is a prompt to reshare. */
export const LOST_STATES = ['problem', 'given_back', 'dropped'];

/** Spare pieces still in the record: the shares past the guardians' that were not handed out. */
export const sparesLeft = (run) => (run?.shares ?? []).slice(run?.guardians?.length ?? 0).filter(Boolean).length;

/** How many spare pieces guardian `userHash` was handed (run.sparesGiven). */
export const sparesHeldBy = (run, userHash) => Object.values(run?.sparesGiven ?? {}).filter((g) => g.guardian === userHash).length;

/**
 * The health line of a finished backup: holders are the guardians whose piece
 * is 'stored'. Pieces sent or delivered but not yet stored are "on the way":
 * a fresh backup reads as arriving, not as broken. A piece with a problem,
 * given back or dropped is neither.
 */
export const healthView = (run, receipts = {}) => {
	const guardians = run?.guardians ?? [];
	const total = guardians.length;
	const needed = run ? neededGuardians(run.settings) : 0;
	const states = guardians.map((g) => guardianDelivery(run, g.userHash, receipts));
	const holders = states.filter((s) => s === 'stored').length;
	const onTheWay = states.filter((s) => s === 'sent' || s === 'delivered').length;
	let level = healthOf(holders, needed);
	if (level !== 'spare_2' && level !== 'spare_1' && onTheWay > 0 && holders + onTheWay >= needed) level = 'pending';
	let detail = `${needed} needed`;
	if (level === 'pending') detail = `${needed} needed · ${plural(onTheWay, 'piece')} on the way`;
	else if (level === 'at_threshold') detail = `${needed} needed. If fewer than ${needed} guardians keep their piece, the backup stops working.`;
	else if (level === 'broken') detail = `${needed} needed. Fewer than ${needed} guardians keep their piece: the backup stopped working.`;
	return { total, needed, holders, onTheWay, level, detail };
};

/**
 * The roster of a finished backup (plan § 7.4): its health, each guardian by
 * what they said about their piece — with the hint under a piece that no
 * longer counts, and the spare pieces they hold — and the call to reshare,
 * or null: pieces that no longer count, or a backup at or below what it
 * needs. `nameOf(userHash)` names a guardian.
 */
export const rosterView = (run, receipts = {}, receiptDetails = {}, nameOf = () => 'Guardian') => {
	const health = healthView(run, receipts);
	const rows = (run?.guardians ?? []).map((g) => {
		const state = guardianDelivery(run, g.userHash, receipts);
		return {
			userHash: g.userHash,
			name: nameOf(g.userHash),
			state,
			text: ROSTER_TEXT[state],
			hint: deliveryHint(state, receiptDetails?.[g.userHash]?.detail),
			spares: sparesHeldBy(run, g.userHash),
		};
	});
	const lost = rows.filter((r) => LOST_STATES.includes(r.state));
	let prompt = null;
	if (lost.length) {
		const names = lost.map((r) => r.name).join(', ');
		prompt = {
			text: `${names} no longer ${lost.length === 1 ? 'keeps a piece' : 'keep a piece'} that counts. A reshare gives the guardians you pick new pieces and makes the old ones useless.`,
			action: 'Reshare to replace',
		};
	} else if (health.level === 'broken') prompt = { text: 'The backup does not work now: too few guardians keep their piece. Reshare it to guardians who will.', action: 'Reshare to replace' };
	else if (health.level === 'at_threshold') prompt = { text: 'One more lost piece and the backup stops working. Adding a guardian gives it a margin.', action: 'Add guardians' };
	return { health, rows, lost, prompt };
};

/**
 * The nodes of a finished backup: each by what it did with its part, or — once
 * `holdings` (store.holdings) were checked for this record — by what it holds
 * now; how many hold it against the node threshold, and the call to reshare
 * once a node lost its part: every loss eats into the spare, and below the
 * threshold the node half cannot be rebuilt. `nameOf(ref)` names a node.
 */
export const nodesView = (run, holdings, nameOf = (ref) => hostOf(ref.url)) => {
	const checked = holdings?.runId && holdings.runId === run?.runId ? holdings.byNode : {};
	const rows = (run?.nodes ?? []).map((n) => {
		let state = 'waiting';
		if (run.skippedNodes?.includes(n.id)) state = 'left_out';
		else if (checked[n.id]) state = checked[n.id];
		else if (nodeHolds(run, n.id)) state = 'holds';
		else if (run.nodeOutcomes?.[n.id]?.state === 'failed') state = 'failed';
		const [text, cls] = {
			holds: ['holds its part', 'cb-status-ok'],
			lost: ['lost its part', 'cb-status-warn'],
			unreachable: ['not answering', 'cb-status-warn'],
			left_out: ['left out', 'cb-status-warn'],
			failed: ['did not take its part', 'cb-status-warn'],
			waiting: ['waiting', 'cb-status-off'],
		}[state];
		return { id: n.id, name: nameOf(n), host: hostOf(n.url), state, text, cls };
	});
	const holding = rows.filter((r) => r.state === 'holds').length;
	const lost = rows.filter((r) => r.state === 'lost').length;
	const needed = run?.settings?.nodeThreshold ?? 0;
	let prompt = null;
	if (lost) {
		const head = `${plural(lost, 'node')} lost ${lost === 1 ? 'its' : 'their'} part: ${holding} of ${rows.length} hold it, ${needed} needed.`;
		prompt = {
			text: holding < needed ? `${head} The node half cannot be rebuilt now: reshare to nodes that hold it.` : `${head} A reshare gives the nodes new parts before more are lost.`,
			action: 'Reshare to replace',
		};
	}
	return { rows, holding, lost, needed, prompt };
};

// --- Nodes -----------------------------------------------------------------------------

const STABLE = 'A backup has to work for years and from anywhere, so a node needs a stable https address.';
/** Why a node refused at the address check, in words (design 5.3). */
export const nodeCheckText = (reason) =>
	({
		private_address: `This is a home network address. ${STABLE}`,
		not_https: `This is not a stable https address of a node. ${STABLE}`,
		unreachable: 'No node answers at this address.',
		not_endorsed: 'The operator has not signed this node yet.',
		operator_unknown: 'The operator of this node is not someone this app can check.',
		wrong_deployment: 'This node serves another network.',
	})[reason] ?? 'This node\'s signature does not check out.';

/** A known node's address that did not verify, as its list row says it. */
export const refusedNodeStatus = (reason) =>
	({ not_endorsed: 'not ready', unreachable: 'not answering', private_address: 'home network', not_https: 'not https', wrong_deployment: 'another network' })[
		reason
	] ?? 'does not verify';

// --- The draft ---------------------------------------------------------------------------

/**
 * The backup being set up. `store` is the recovery backup store; the draft
 * reads its candidates and nodes and builds what store.start takes.
 */
export const createBackupDraft = (store) => {
	const state = reactive({
		/** userHash of each guardian picked. */
		selected: [],
		/** Whether the owner touched the picker: until then every agreed contact is picked. */
		touched: false,
		/** "I understand, use 2 guardians". */
		twoAck: false,
		/** Advanced's numbers over the defaults: threshold, approvals, spares, delaySec, windowSec. */
		custom: {},
		/** Advanced's working copy while it is open (sub-screens leave and come back). */
		work: null,
		/** The nodes picked by id; null while the suggested set stands. */
		nodeIds: null,
		nodeThreshold: null,
		fee: { choice: 'buckitup', url: '' },
		/** The last self-pay quote: { address, balance, estimate, enough }. */
		quote: null,
		alerts: { telegram: false, webhook: false, skipped: false },
		nodesLoading: false,
		/** The run finished while this flow was open: the summary says so. */
		justFinished: false,
		/**
		 * Set while the setup is a reshare of the finished backup (plan § 7.4):
		 * { guardians }, the userHashes it has now. The screens then skip
		 * Alerts, and startPayload is a reshare's.
		 */
		reshare: null,
	});

	const guardians = computed(() => store.pickable.filter((c) => state.selected.includes(c.userHash)));
	const guardianHashes = computed(() => guardians.value.map((g) => g.userHash));

	// Every agreed contact is picked until the owner changes the selection.
	watch(
		() => store.pickable.map((c) => c.userHash).join(),
		() => {
			const hashes = store.pickable.map((c) => c.userHash);
			state.selected = state.touched ? state.selected.filter((h) => hashes.includes(h)) : hashes;
		},
		{ immediate: true },
	);

	const toggle = (userHash) => {
		state.touched = true;
		state.twoAck = false;
		state.selected = state.selected.includes(userHash) ? state.selected.filter((h) => h !== userHash) : [...state.selected, userHash];
		// Pieces and approvals are counted against the guardians: a new count starts from its defaults.
		const rest = { ...state.custom };
		delete rest.threshold;
		delete rest.approvals;
		state.custom = rest;
	};

	const suggested = computed(() => defaultNodeSet(store.nodes, guardianHashes.value));
	const nodes = computed(() =>
		state.nodeIds === null ? suggested.value.nodes : state.nodeIds.map((id) => store.nodes.find((n) => n.descriptor.id === id)).filter(Boolean),
	);
	/** Turns the suggested set into an explicit one, before the owner edits it. */
	const pinNodes = () => {
		if (state.nodeIds === null) state.nodeIds = suggested.value.nodes.map((n) => n.descriptor.id);
	};
	const setNodes = (ids) => {
		state.nodeIds = ids;
		// A threshold keeps a spare node.
		if (state.nodeThreshold !== null) state.nodeThreshold = Math.max(2, Math.min(state.nodeThreshold, ids.length - 1));
	};

	const settings = computed(() => {
		const base = defaultSettings(guardians.value.length, nodes.value.length);
		return { ...base, ...state.custom, nodeThreshold: state.nodeThreshold ?? base.nodeThreshold };
	});
	const nodeIssues = computed(() => setProblems(nodes.value, settings.value.nodeThreshold, guardianHashes.value));
	const operatorShortfall = computed(() => nodeIssues.value.find((p) => p.kind === 'too_few_operators') ?? null);

	/** The fee as it will be paid: past the free service's limit it is the owner's own. */
	const freeTooSmall = computed(() => !relayerCanTake(guardians.value.length));
	const feeChoice = computed(() => (state.fee.choice === 'buckitup' && freeTooSmall.value ? 'self' : state.fee.choice));

	const alertChannels = computed(() => ['app', ...(state.alerts.telegram ? ['telegram'] : []), ...(state.alerts.webhook ? ['webhook'] : [])]);
	const alertsConnected = computed(() => state.alerts.telegram || state.alerts.webhook);

	/** Why Simple's Next is off, or null (design 3.x). */
	const blockReason = computed(() => {
		const m = guardians.value.length;
		if (m === 0) return 'Pick at least 2 guardians.';
		if (m === 1) return 'One guardian is not enough: a backup needs at least 2.';
		if (m === 2 && !state.twoAck) return 'Confirm the warning above to use 2 guardians.';
		if (state.nodesLoading && !store.nodes.length) return 'Looking for nodes…';
		const short = operatorShortfall.value;
		if (short) return `Add ${plural(short.need - short.have, 'more node operator')} to continue.`;
		if (nodeIssues.value.length) return 'The nodes need attention: open Change settings, then Nodes.';
		if (settingsProblems(settings.value, m, nodes.value.length).length) return 'Some settings are out of bounds: open Change settings.';
		// The balance is read on the Fee and Review screens: not having read it yet is no reason to stop here.
		if (feeChoice.value === 'self' && !state.quote) return null;
		return feeProblem(feeChoice.value, state.fee.url, state.quote);
	});

	const summaryLine = computed(() => {
		const s = settings.value;
		return `${plural(s.spares, 'spare piece')} · ${s.nodeThreshold} of ${nodes.value.length} nodes · ${durationAdjective(s.delaySec)} wait · ${feeText(feeChoice.value)}`;
	});

	/**
	 * Turns the draft into a reshare of `record`, the finished backup, filled
	 * in from it: its guardians, pieces, approvals and spares, its nodes and
	 * how it pays. The waiting period and the time to finish are the
	 * record's — a reshare keeps them (store.start; setPolicy changes them).
	 * A guardian who no longer agrees cannot be picked, and with fewer
	 * guardians than the record's the counts start from their defaults.
	 */
	const beginReshare = (record) => {
		const hashes = record.guardians.map((g) => g.userHash);
		const pickable = store.pickable.map((c) => c.userHash);
		const s = record.settings;
		const sameGuardians = hashes.every((h) => pickable.includes(h));
		Object.assign(state, {
			reshare: { guardians: hashes },
			selected: hashes.filter((h) => pickable.includes(h)),
			touched: true,
			twoAck: hashes.length === 2,
			custom: { spares: s.spares, delaySec: s.delaySec, windowSec: s.windowSec, ...(sameGuardians ? { threshold: s.threshold, approvals: s.approvals } : {}) },
			work: null,
			nodeIds: record.nodes.map((n) => n.id),
			nodeThreshold: s.nodeThreshold,
			fee: record.fee?.kind === 'self' ? { choice: 'self', url: '' } : record.fee?.url ? { choice: 'other', url: record.fee.url } : { choice: 'buckitup', url: '' },
			quote: null,
			justFinished: false,
		});
	};

	const resharing = computed(() => !!state.reshare);
	/** A reshare's guardians who are not in the backup now, and the backup's who are not picked: userHashes. */
	const joining = computed(() => (state.reshare ? guardianHashes.value.filter((h) => !state.reshare.guardians.includes(h)) : []));
	const leaving = computed(() => (state.reshare ? state.reshare.guardians.filter((h) => !guardianHashes.value.includes(h)) : []));

	/** What store.start takes; a reshare keeps the backup's alerts, so it names none. */
	const startPayload = () => {
		const choice = feeChoice.value;
		const payload = {
			guardians: guardians.value.map((g) => ({ userHash: g.userHash, metaAddress: g.metaAddress })),
			settings: { ...settings.value },
			nodes: [...nodes.value],
			fee: choice === 'self' ? { kind: 'self' } : choice === 'other' ? { kind: 'relayer', url: state.fee.url.trim() } : { kind: 'relayer' },
		};
		if (state.reshare) return { ...payload, reshare: true };
		return { ...payload, alerts: { channels: [...alertChannels.value], skipped: !alertsConnected.value && state.alerts.skipped } };
	};

	return {
		state,
		guardians,
		guardianHashes,
		toggle,
		nodes,
		pinNodes,
		setNodes,
		settings,
		nodeIssues,
		operatorShortfall,
		freeTooSmall,
		feeChoice,
		alertChannels,
		alertsConnected,
		blockReason,
		summaryLine,
		startPayload,
		beginReshare,
		resharing,
		joining,
		leaving,
	};
};
