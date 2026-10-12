// What the community backup screens share (docs/design-recovery-backup.md):
// the setup being drafted — guardians, settings, nodes, fee, alerts — and the
// wording the card, the progress screen and the summary all say the same way.
// The rules themselves live in src/lib/recovery; this only asks them.
import { computed, reactive, watch } from 'vue';
import { defaultSettings, settingsProblems, neededGuardians, relayerCanTake, healthOf, durationText } from '@/lib/recovery/backupPlan';
import { defaultNodeSet, setProblems, operatorOf, BUCKITUP } from '@/lib/recovery/nodeChoice';

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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export { plural };

/** "Daria Kim" → "DK", "Milo" → "MI". */
export const initials = (name) => {
	const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
	if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
	return (words[0] || '?').slice(0, 2).toUpperCase();
};

const AVATAR_TONES = [
	['#e9d5f0', '#8e2b77'],
	['#dbe7f5', '#2c4f8a'],
	['#e0efd9', '#3c6b2c'],
	['#f6e3d3', '#8a4b1d'],
	['#e5e3f6', '#4b3f8a'],
];
/** A stable colour pair for a contact's initials. */
export const avatarTone = (key) => {
	let h = 0;
	for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const [background, color] = AVATAR_TONES[h % AVATAR_TONES.length];
	return { background, color };
};

/** "0x7a3F…c91E". */
export const shortAddress = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

export const hostOf = (url) => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

/** "3 days" → "3-day", as in "3-day wait". */
export const durationAdjective = (sec) => durationText(sec).replace(/s$/, '').replace(' ', '-');

/** "2 days ago", "5 minutes ago", "just now". */
export const agoText = (sec, now = Math.floor(Date.now() / 1000)) => {
	const d = Math.max(0, now - sec);
	if (d < 60) return 'just now';
	if (d < 3600) return `${plural(Math.floor(d / 60), 'minute')} ago`;
	if (d < 86400) return `${plural(Math.floor(d / 3600), 'hour')} ago`;
	return `${plural(Math.floor(d / 86400), 'day')} ago`;
};

/** Who runs a node, as a person reads it: BuckitUp, a contact's name, you, or its address. */
export const operatorLabel = (operatorHash, { contactsMap = {}, me = null, url = '' } = {}) => {
	if (operatorOf(operatorHash) === BUCKITUP) return 'BuckitUp';
	if (me && operatorHash === me) return 'You';
	const name = contactsMap?.[operatorHash]?.name;
	if (name) return name;
	return url ? hostOf(url) : 'Unknown operator';
};

export const ALERT_NAMES = { app: 'app', telegram: 'Telegram', webhook: 'webhook' };
/** "app, Telegram". */
export const alertsText = (channels = ['app']) => channels.map((c) => ALERT_NAMES[c] ?? c).join(', ');
/** Whether a channel outside the app is on: the app alone can be lost with the phone. */
export const hasOutsideAlerts = (alerts) => !!alerts?.channels?.some((c) => c !== 'app');

/**
 * Where guardian `userHash`'s piece stands: 'waiting' | 'sent' | 'delivered' | 'stored'.
 *
 * Phase 7.3 hook: `receipts` will carry what the guardians' apps report
 * (delivered, stored). Until then only `run.sent` is known, so a guardian is
 * 'sent' or 'waiting'.
 */
export const guardianDelivery = (run, userHash, receipts = {}) => receipts[userHash] ?? (run?.sent?.[userHash] ? 'sent' : 'waiting');

/** Guardians holding a piece: 'stored' only, which phase 7.3 reports. */
export const holdersOf = (run, receipts = {}) => (run?.guardians ?? []).filter((g) => guardianDelivery(run, g.userHash, receipts) === 'stored').length;

/**
 * The health line of a finished backup. Pieces sent but not yet stored are
 * "on the way": a fresh backup reads as arriving, not as broken.
 */
export const healthView = (run, receipts = {}) => {
	const total = run?.guardians?.length ?? 0;
	const needed = run ? neededGuardians(run.settings) : 0;
	const holders = holdersOf(run, receipts);
	const onTheWay = (run?.guardians ?? []).filter((g) => ['sent', 'delivered'].includes(guardianDelivery(run, g.userHash, receipts))).length;
	let level = healthOf(holders, needed);
	if (level !== 'spare_2' && level !== 'spare_1' && onTheWay > 0 && holders + onTheWay >= needed) level = 'pending';
	let detail = `${needed} needed`;
	if (level === 'pending') detail = `${needed} needed · ${plural(onTheWay, 'piece')} on the way`;
	else if (level === 'at_threshold') detail = `${needed} needed. If fewer than ${needed} guardians keep their piece, the backup stops working.`;
	else if (level === 'broken') detail = `${needed} needed. Fewer than ${needed} guardians keep their piece: the backup stopped working.`;
	return { total, needed, holders, onTheWay, level, detail };
};

const HOME_SUFFIXES = ['localhost', 'local', 'home.arpa', 'internal', 'lan', 'intranet', 'corp', 'home', 'private'];
/** An address only a home or office network reaches: a bare IP, or a local name. */
const isHomeAddress = (url) => {
	let host;
	try {
		host = new URL(url).hostname.replace(/\.$/, '');
	} catch {
		return false;
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return true;
	return !host.includes('.') || HOME_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
};

/** Why a node refused at the address check, in words (design 5.3). */
export const nodeCheckText = (reason, url = '') => {
	switch (reason) {
		case 'not_https':
			return isHomeAddress(url)
				? 'This is a home network address. A backup has to work for years and from anywhere, so a node needs a stable https address.'
				: 'Not https. A backup has to work for years and from anywhere, so a node needs a stable https address.';
		case 'unreachable':
			return 'No node answers at this address.';
		case 'not_endorsed':
			return 'The operator has not signed this node yet.';
		case 'operator_unknown':
			return 'The operator of this node is not someone this app can check.';
		case 'wrong_deployment':
			return 'This node serves another network.';
		default:
			return 'This node\'s signature does not check out.';
	}
};

/** A known node's address that did not verify, as its list row says it. */
export const refusedNodeStatus = (reason) =>
	({ not_endorsed: 'not ready', unreachable: 'not answering', not_https: 'not https', wrong_deployment: 'another network' })[reason] ?? 'does not verify';

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
	});

	const agreed = computed(() => store.candidates.filter((c) => c.status === 'agreed' && c.metaAddress));
	const guardians = computed(() => agreed.value.filter((c) => state.selected.includes(c.userHash)));
	const guardianHashes = computed(() => guardians.value.map((g) => g.userHash));

	// Every agreed contact is picked until the owner changes the selection.
	watch(
		() => agreed.value.map((c) => c.userHash).join(),
		() => {
			if (!state.touched) state.selected = agreed.value.map((c) => c.userHash);
			else state.selected = state.selected.filter((h) => agreed.value.some((c) => c.userHash === h));
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
		if (state.nodeThreshold !== null) state.nodeThreshold = Math.max(2, Math.min(state.nodeThreshold, ids.length));
	};

	const settings = computed(() => {
		const base = defaultSettings(guardians.value.length, nodes.value.length);
		return { ...base, ...state.custom, nodeThreshold: state.nodeThreshold ?? base.nodeThreshold };
	});
	const settingsIssues = computed(() => settingsProblems(settings.value, guardians.value.length, nodes.value.length));
	const nodeIssues = computed(() => setProblems(nodes.value, settings.value.nodeThreshold, guardianHashes.value));
	const operatorShortfall = computed(() => nodeIssues.value.find((p) => p.kind === 'too_few_operators') ?? null);

	/** The fee as it will be paid: past the free service's limit it is the owner's own. */
	const freeTooSmall = computed(() => !relayerCanTake(guardians.value.length));
	const feeChoice = computed(() => (state.fee.choice === 'buckitup' && freeTooSmall.value ? 'self' : state.fee.choice));
	const feePayload = computed(() => {
		if (feeChoice.value === 'self') return { kind: 'self' };
		if (feeChoice.value === 'other') return { kind: 'relayer', url: state.fee.url.trim() };
		return { kind: 'relayer' };
	});
	const feeText = computed(() => ({ buckitup: 'free', other: 'another service', self: 'paid from your address' })[feeChoice.value]);
	const feeIssue = computed(() => {
		if (feeChoice.value === 'other' && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(state.fee.url.trim())) return 'Type the https address of the service that pays the fee.';
		if (feeChoice.value === 'self' && state.quote && !state.quote.enough) return 'Balance is too low for the fee.';
		return null;
	});

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
		if (settingsIssues.value.length) return 'Some settings are out of bounds: open Change settings.';
		return feeIssue.value;
	});

	const summaryLine = computed(() => {
		const s = settings.value;
		return `${plural(s.spares, 'spare piece')} · ${s.nodeThreshold} of ${nodes.value.length} nodes · ${durationAdjective(s.delaySec)} wait · ${feeText.value}`;
	});

	/** What store.start takes. */
	const startPayload = () => ({
		guardians: guardians.value.map((g) => ({ userHash: g.userHash, metaAddress: g.metaAddress })),
		settings: { ...settings.value },
		nodes: [...nodes.value],
		fee: { ...feePayload.value },
		alerts: { channels: [...alertChannels.value], skipped: !alertsConnected.value && state.alerts.skipped },
	});

	return {
		state,
		agreed,
		guardians,
		guardianHashes,
		toggle,
		suggested,
		nodes,
		pinNodes,
		setNodes,
		settings,
		settingsIssues,
		nodeIssues,
		operatorShortfall,
		freeTooSmall,
		feeChoice,
		feePayload,
		feeText,
		feeIssue,
		alertChannels,
		alertsConnected,
		blockReason,
		summaryLine,
		startPayload,
	};
};
