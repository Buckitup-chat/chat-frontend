// Message content codec (invariants/07_content_polymorphism.md).
//
// The wire form inside content_b64 is JSON by convention: a bare string is
// text, a one-key object is typed content, an array composes parts. The type
// lives inside the ciphertext on purpose — the database must not learn
// whether a row is text, a photo or a document.
//
// This client historically emitted {"type":"text","text":…}, which only ever
// worked because both ends shared the same ad-hoc convention. Decoding keeps
// that legacy readable; encoding emits only the canonical form.
//
// The "quote" envelope is defined here first (the registry in
// 07_content_polymorphism.md needs a matching entry — flagged in the PR):
//
//   {"quote": [author_hash, message_id, sign_hash, snapshot]}
//
// snapshot is itself canonical content — the quote carries the cited text so
// it renders even when the original never arrived or was deleted, and quoting
// a message that itself contains a quote nests naturally. (message_id,
// sign_hash) pin the exact revision for the jump-to-original affordance; the
// snapshot stays frozen at citation time regardless of later edits.

/** Positions past the ones this build knows, from a newer build (07: fields
 * are append-only): kept, so re-encoding — a quote's snapshot above all —
 * loses nothing. Absent when the envelope had no such tail. */
interface Extensible {
	rest?: unknown[];
}

export interface TextPart {
	kind: 'text';
	text: string;
}

export interface QuotePart extends Extensible {
	kind: 'quote';
	authorHash: string;
	messageId: string;
	signHash: string;
	/** Frozen at citation time; renders independently of the original row. */
	snapshot: ContentPart[];
}

/** Out-of-band file attachment (07 §"file"): the bytes live as encrypted
 * chunks on the device; the envelope carries the reference and the key. */
export interface FilePart extends Extensible {
	kind: 'file';
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	fileId: string;
	encSecretB64: string;
}

/**
 * Out-of-band image (07 §"image"). Extends the file reference with what the
 * UI needs to lay the picture out before a single byte arrives: the aspect
 * ratio and a ThumbHash to blur in behind it, so the bubble does not jump
 * when the real image lands.
 */
export interface ImagePart extends Extensible {
	kind: 'image';
	widthAspect: number;
	heightAspect: number;
	thumbHashB64: string;
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	fileId: string;
	encSecretB64: string;
}

/** Out-of-band video (07 §"video"). Same shape as an image — the preview
 * frame's ThumbHash and the aspect ratio — because the player needs to lay
 * the frame out before it can stream anything, plus the playback duration so
 * the preview can carry its badge before a single chunk arrives. Always
 * out-of-band: there is no inline variant. */
export interface VideoPart extends Omit<ImagePart, 'kind'> {
	kind: 'video';
	/** Whole seconds; 0 when the sender could not determine it. */
	durationSeconds: number;
}

/**
 * Signed DAG checkpoint (07 §"checkpoint"): commitments to the causal
 * history (frontier) and the materialized view of a dialog at a moment this
 * device confirmed. Rides an ordinary message, so the commitments stay
 * inside the ciphertext and the signature/transport come for free — the
 * server sees a normal row. Semantics and derivations: src/lib/pq/checkpoint.ts.
 */
export interface CheckpointPart extends Extensible {
	kind: 'checkpoint';
	version: number;
	reducerVersion: string;
	treeVersion: string;
	frontierRoot: string;
	viewRoot: string;
	/** message_id → sign_hash tails observed at checkpoint time (source of
	 * truth; frontierRoot is its fingerprint). */
	frontier: Record<string, string>;
	createdAt: number;
}

/**
 * One guardian's Shamir share of the friends' half of an owner's community
 * backup (07 §"recovery_share"; lifecycle in the chat repo's
 * docs/pq/reqs/pq_recovery_shares.proposed.md). The codec holds the envelope
 * to its shape; whether the share belongs to the split whose root is on chain
 * is lib/recovery/shareSplit's checkShare.
 */
export interface RecoverySharePart {
	kind: 'recovery_share';
	/** `<namespace>/<id>`, e.g. `eip155:<chainId>:<contract>/<secret id>`. */
	secretRef: string;
	version: number;
	/** Shamir shares needed; not the contract's approval quorum. */
	threshold: number;
	total: number;
	/** The share itself, unpadded base64. */
	shareB64: string;
	createdAt: number;
	splitId: string;
	/** 1-based. */
	shareIndex: number;
	/** Every leaf of the split in index order, unpadded base64; empty when the sender sent none, which no check passes. */
	splitProof: string[];
	/** The nodes holding the node half and their threshold; null when the sender sent none, which no check passes. */
	nodeSet: NodeSet | null;
	/** Positions past node_set, from a newer build: kept, so re-encoding loses nothing. */
	rest?: unknown[];
}

/** A guardian's share sent back to a recovering owner's temporary account (07 § recovery_share_return). */
export interface RecoveryShareReturnPart extends Extensible {
	kind: 'recovery_share_return';
	secretRef: string;
	version: number;
	splitId: string;
	threshold: number;
	total: number;
	shareIndex: number;
	/** The contract's recoveryRound this release answers. */
	round: number;
	/** The recipient address the guardian approved. */
	candidate: string;
	shareB64: string;
	createdAt: number;
	splitProof: string[];
	nodeSet: NodeSet | null;
}

/** A recovering account's proof that it holds the on-chain candidate key (07 § recovery_binding). */
export interface RecoveryBindingPart extends Extensible {
	kind: 'recovery_binding';
	secretRef: string;
	candidate: string;
	/** The sender's own user_hash. */
	userHash: string;
	signatureB64: string;
}

/** An owner asking a contact to become a guardian (07 § recovery_invite). */
export interface RecoveryInvitePart extends Extensible {
	kind: 'recovery_invite';
	/** 16 random bytes, lowercase hex. */
	inviteId: string;
	/** `eip155:<chainId>:<contract>`, where the guardian would approve. */
	deployment: string;
	createdAt: number;
}

/** The contact's answer to an invitation (07 § recovery_invite_reply). */
export interface RecoveryInviteReplyPart extends Extensible {
	kind: 'recovery_invite_reply';
	inviteId: string;
	/** "accept" or "decline"; any other value is ignored by the owner. */
	answer: string;
	/** On accept, the 66-byte stealth meta-address as lowercase 0x hex; empty on decline. */
	metaAddress: string;
	/** On accept, the spending key's EIP-191 signature, unpadded base64; empty on decline. */
	proofB64: string;
	createdAt: number;
}

/**
 * The nodes holding a version's node half, as a share envelope names them
 * (07 § recovery_share, node_set: `[node_threshold, ["<id>@<url>", …]]`).
 * The codec holds only this shape; the rules a set must obey, and its hash in
 * the split's root, are lib/recovery/nodeSet's.
 */
export interface NodeSet {
	/** Node shares needed to rebuild the node half. */
	threshold: number;
	/** `<id>@<url>` per node, in the order the hash takes them. */
	nodes: string[];
}

const nodeSetToWire = (set: NodeSet): unknown[] => [set.threshold, [...set.nodes]];

const nodeSetFromWire = (wire: unknown): NodeSet | null =>
	// Exactly two elements: the root covers both and nothing else, so a third
	// would ride along unauthenticated (07 § recovery_share, node_set).
	Array.isArray(wire) && wire.length === 2 && isInt(wire[0]) && Array.isArray(wire[1]) && wire[1].every((entry: unknown) => typeof entry === 'string')
		? { threshold: wire[0], nodes: [...(wire[1] as string[])] }
		: null;

/** A typed value this build does not render yet (e.g. "image" before the
 * file transport lands). Preserved verbatim so re-encoding loses nothing. */
export interface UnknownPart {
	kind: 'unknown';
	type: string;
	value: unknown;
}

export type ContentPart =
	| TextPart
	| QuotePart
	| FilePart
	| ImagePart
	| VideoPart
	| CheckpointPart
	| RecoverySharePart
	| RecoveryShareReturnPart
	| RecoveryBindingPart
	| RecoveryInvitePart
	| RecoveryInviteReplyPart
	| UnknownPart;

export class ContentDecodeError extends Error {}

// Wire grammar of a checkpoint frontier entry (pq_dialogs.md: message_id =
// "dmsg_" + UUIDv7; sign_hash = "dms_" + 128 hex chars).
export const isWireMessageId = (s: string): boolean => FRONTIER_MESSAGE_ID.test(s);
const FRONTIER_MESSAGE_ID = /^dmsg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRONTIER_SIGN_HASH = /^dms_[0-9a-f]{128}$/;

const encodePart = (part: ContentPart): unknown => {
	switch (part.kind) {
		case 'text':
			return part.text;
		case 'quote':
			return {
				quote: [
					part.authorHash, part.messageId, part.signHash, encodeValue(part.snapshot.map(quotable)),
					...(part.rest ?? []),
				],
			};
		case 'file':
			return {
				file: [part.name, part.size, part.mimeType, part.createdAt, part.fileId, part.encSecretB64, ...(part.rest ?? [])],
			};
		case 'image':
			return {
				image: [
					part.widthAspect, part.heightAspect, part.thumbHashB64, part.name, part.size,
					part.mimeType, part.createdAt, part.fileId, part.encSecretB64, ...(part.rest ?? []),
				],
			};
		case 'video':
			return {
				video: [
					part.widthAspect, part.heightAspect, part.thumbHashB64, part.name, part.size,
					part.mimeType, part.createdAt, part.durationSeconds || 0,
					part.fileId, part.encSecretB64, ...(part.rest ?? []),
				],
			};
		case 'checkpoint':
			return {
				checkpoint: [
					part.version, part.reducerVersion, part.treeVersion,
					part.frontierRoot, part.viewRoot, part.frontier, part.createdAt, ...(part.rest ?? []),
				],
			};
		case 'recovery_share':
			return {
				recovery_share: [
					part.secretRef, part.version, part.threshold, part.total, part.shareB64,
					part.createdAt, part.splitId, part.shareIndex, part.splitProof,
					...withNodeSet(part.nodeSet, part.rest),
				],
			};
		case 'recovery_share_return':
			return {
				recovery_share_return: [
					part.secretRef, part.version, part.splitId, part.threshold, part.total, part.shareIndex,
					part.round, part.candidate, part.shareB64, part.createdAt, part.splitProof,
					...withNodeSet(part.nodeSet, part.rest),
				],
			};
		case 'recovery_binding':
			return {
				recovery_binding: [part.secretRef, part.candidate, part.userHash, part.signatureB64, ...(part.rest ?? [])],
			};
		case 'recovery_invite':
			return { recovery_invite: [part.inviteId, part.deployment, part.createdAt, ...(part.rest ?? [])] };
		case 'recovery_invite_reply':
			return {
				recovery_invite_reply: [
					part.inviteId, part.answer, part.metaAddress, part.proofB64, part.createdAt, ...(part.rest ?? []),
				],
			};
		case 'unknown':
			return { [part.type]: part.value };
	}
};

/** A node set as the tail of a share envelope: absent only when nothing follows it. */
const withNodeSet = (nodeSet: NodeSet | null, rest: unknown[] | undefined): unknown[] =>
	nodeSet ? [nodeSetToWire(nodeSet), ...(rest ?? [])] : rest?.length ? [null, ...rest] : [];

/** How each recovery message reads in text, previews and quotes. */
const RECOVERY_LABELS = {
	recovery_share: '🔐 recovery share',
	recovery_share_return: '🔐 recovery share returned',
	recovery_binding: '🔐 recovery binding',
	recovery_invite: '🛡 guardian invitation',
	recovery_invite_reply: '🛡 guardian invitation answered',
} as const;

type RecoveryPart = Extract<ContentPart, { kind: keyof typeof RECOVERY_LABELS }>;
const isRecoveryPart = (part: ContentPart): part is RecoveryPart => Object.hasOwn(RECOVERY_LABELS, part.kind);

/** What a quote copies as it is; every other part is named by a label. */
const COPIED_IN_QUOTES = new Set<ContentPart['kind']>(['text', 'quote', 'file', 'image', 'video', 'checkpoint']);

/**
 * What a quote may carry of a part: the kinds known to be safe to repeat, and
 * a label for everything else. A recovery message — or a type this build does
 * not know, which a future recovery type would be — is named, never copied: a
 * reply would otherwise put a share's bytes, a key or a proof into a second
 * message its sender never sent.
 */
const quotable = (part: ContentPart): ContentPart => {
	if (COPIED_IN_QUOTES.has(part.kind)) return part;
	if (isRecoveryPart(part)) return { kind: 'text', text: RECOVERY_LABELS[part.kind] };
	return { kind: 'text', text: part.kind === 'unknown' ? `[${part.type}]` : `[${part.kind}]` };
};

/** A reply's snapshot of the message it cites, made safe to keep: see quotable. */
export const quoteSnapshot = (parts: ContentPart[]): ContentPart[] => parts.map(quotable);

const encodeValue = (parts: ContentPart[]): unknown => {
	if (parts.length === 1) return encodePart(parts[0]);
	return parts.map(encodePart);
};

/** Canonical wire JSON. A single text part becomes a bare string. */
export const encodeContent = (parts: ContentPart[]): string => {
	if (parts.length === 0) return JSON.stringify('');
	return JSON.stringify(encodeValue(parts));
};

const decodeValue = (value: unknown): ContentPart[] => {
	if (typeof value === 'string') return [{ kind: 'text', text: value }];

	if (Array.isArray(value)) {
		// Nested arrays are grouping only — flatten for a vertical render.
		return value.flatMap(decodeValue);
	}

	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value as Record<string, unknown>);
		const obj = value as Record<string, unknown>;

		// Legacy this client used to emit; read-only compatibility.
		if (obj.type === 'text' && typeof obj.text === 'string') {
			return [{ kind: 'text', text: obj.text }];
		}

		// Canonical compound content: exactly one key naming the type.
		if (keys.length === 1) {
			const type = keys[0];
			if (type === 'quote') {
				const q = obj.quote;
				if (
					!Array.isArray(q) || q.length < 4 ||
					typeof q[0] !== 'string' || typeof q[1] !== 'string' || typeof q[2] !== 'string'
				) {
					throw new ContentDecodeError('malformed quote envelope');
				}
				return [{
					kind: 'quote',
					authorHash: q[0],
					messageId: q[1],
					signHash: q[2],
					snapshot: decodeValue(q[3]),
					...tailOf(q, 4),
				}];
			}
			if (type === 'image' || type === 'video') {
				// positions 0–6 are shared media metadata; the tail is per-type:
				// image ends [7]=file_id [8]=enc_secret,
				// video ends [7]=duration [8]=file_id [9]=enc_secret
				const im = obj[type];
				if (!Array.isArray(im)) {
					throw new ContentDecodeError(`malformed ${type} envelope`);
				}
				const media = {
					widthAspect: Number(im[0]) || 1,
					heightAspect: Number(im[1]) || 1,
					thumbHashB64: String(im[2] ?? ''),
					name: String(im[3]),
					size: Number(im[4]),
					mimeType: String(im[5]),
					createdAt: Number(im[6]),
				};
				if (type === 'video') {
					if (im.length < 10 || typeof im[8] !== 'string' || typeof im[9] !== 'string') {
						throw new ContentDecodeError('malformed video envelope');
					}
					return [{
						kind: 'video', ...media, fileId: im[8], encSecretB64: im[9],
						durationSeconds: Math.max(0, Math.round(Number(im[7]))) || 0,
						...tailOf(im, 10),
					}];
				}
				if (im.length < 9 || typeof im[7] !== 'string' || typeof im[8] !== 'string') {
					throw new ContentDecodeError('malformed image envelope');
				}
				return [{ kind: 'image', ...media, fileId: im[7], encSecretB64: im[8], ...tailOf(im, 9) }];
			}
			if (type === 'checkpoint') {
				const c = obj.checkpoint;
				if (
					!Array.isArray(c) || c.length < 7 ||
					typeof c[3] !== 'string' || typeof c[4] !== 'string' ||
					c[5] === null || typeof c[5] !== 'object' || Array.isArray(c[5])
				) {
					throw new ContentDecodeError('malformed checkpoint envelope');
				}
				// The frontier feeds hash pre-images and equality checks, so its
				// entries are held to the exact wire grammar: a key smuggling a
				// delimiter or a truncated hash must die here, not survive as a
				// second reading of a signed commitment.
				for (const [mid, sh] of Object.entries(c[5] as Record<string, unknown>)) {
					if (!FRONTIER_MESSAGE_ID.test(mid) || typeof sh !== 'string' || !FRONTIER_SIGN_HASH.test(sh)) {
						throw new ContentDecodeError('malformed checkpoint frontier entry');
					}
				}
				return [{
					kind: 'checkpoint',
					version: Number(c[0]),
					reducerVersion: String(c[1]),
					treeVersion: String(c[2]),
					frontierRoot: c[3],
					viewRoot: c[4],
					frontier: c[5] as Record<string, string>,
					createdAt: Number(c[6]),
					...tailOf(c, 7),
				}];
			}
			if (type === 'file') {
				const f = obj.file;
				if (!Array.isArray(f) || f.length < 6 || typeof f[4] !== 'string' || typeof f[5] !== 'string') {
					throw new ContentDecodeError('malformed file envelope');
				}
				return [{
					kind: 'file',
					name: String(f[0]),
					size: Number(f[1]),
					mimeType: String(f[2]),
					createdAt: Number(f[3]),
					fileId: f[4],
					encSecretB64: f[5],
					...tailOf(f, 6),
				}];
			}
			if (type === 'recovery_share') return [decodeRecoveryShare(obj.recovery_share)];
			if (type === 'recovery_share_return') return [decodeRecoveryShareReturn(obj.recovery_share_return)];
			if (type === 'recovery_binding') return [decodeRecoveryBinding(obj.recovery_binding)];
			if (type === 'recovery_invite') return [decodeRecoveryInvite(obj.recovery_invite)];
			if (type === 'recovery_invite_reply') return [decodeRecoveryInviteReply(obj.recovery_invite_reply)];
			return [{ kind: 'unknown', type, value: obj[type] }];
		}
	}

	throw new ContentDecodeError(`unrecognized content shape: ${JSON.stringify(value)?.slice(0, 80)}`);
};

const tailOf = (arr: unknown[], known: number): Extensible =>
	arr.length > known ? { rest: arr.slice(known) } : {};

const isInt = (v: unknown): v is number => Number.isInteger(v);

/** Field checks by letter: s string, i integer, n number. */
const FIELD = { s: (v: unknown) => typeof v === 'string', i: isInt, n: (v: unknown) => typeof v === 'number' } as const;

/** The tuple a field signature spells, so the compiler holds the signature and the fields together. */
type Spell<S extends string> = S extends `${infer C}${infer R}` ? [C extends 's' ? string : number, ...Spell<R>] : [];

/** An array whose leading fields have the types `sig` spells, one letter each; its length is at least `sig`'s. */
const head = <S extends string>(r: unknown, sig: S): r is [...Spell<S>, ...unknown[]] =>
	Array.isArray(r) && r.length >= sig.length && [...sig].every((t, i) => FIELD[t as keyof typeof FIELD](r[i]));

const isLeafList = (v: unknown): v is string[] => Array.isArray(v) && v.every((leaf) => typeof leaf === 'string');

/**
 * The optional proof-and-node-set tail of a share envelope, from `at`. Either
 * may be missing — a share without them is kept and fails its check, rather
 * than taking the whole message down as undecodable — but one that is there
 * must have its shape. A node set's rules are checkNodeSet's, at the check.
 */
const shareTail = (r: unknown[], at: number, type: string) => {
	// null is absent, for the proof as for the node set: kept, and it fails its check.
	const proof = r[at] ?? null;
	const wire = r[at + 1] ?? null;
	if (proof !== null && !isLeafList(proof)) throw new ContentDecodeError(`malformed ${type} envelope`);
	const nodeSet = wire === null ? null : nodeSetFromWire(wire);
	if (wire !== null && !nodeSet) throw new ContentDecodeError(`malformed ${type} node set`);
	return { splitProof: proof ?? [], nodeSet, ...tailOf(r, at + 2) };
};

/** Positions 0–7 are required and typed; split_proof (8) and node_set (9) are shareTail's. */
const decodeRecoveryShare = (r: unknown): RecoverySharePart => {
	if (!head(r, 'siiisnsi')) throw new ContentDecodeError('malformed recovery_share envelope');
	return {
		kind: 'recovery_share',
		secretRef: r[0],
		version: r[1],
		threshold: r[2],
		total: r[3],
		shareB64: r[4],
		createdAt: r[5],
		splitId: r[6],
		shareIndex: r[7],
		...shareTail(r, 8, 'recovery_share'),
	};
};

/** Positions 0–9 are required and typed; split_proof (10) and node_set (11) are shareTail's. */
const decodeRecoveryShareReturn = (r: unknown): RecoveryShareReturnPart => {
	if (!head(r, 'sisiiiissn')) throw new ContentDecodeError('malformed recovery_share_return envelope');
	return {
		kind: 'recovery_share_return',
		secretRef: r[0],
		version: r[1],
		splitId: r[2],
		threshold: r[3],
		total: r[4],
		shareIndex: r[5],
		round: r[6],
		candidate: r[7],
		shareB64: r[8],
		createdAt: r[9],
		...shareTail(r, 10, 'recovery_share_return'),
	};
};

const decodeRecoveryBinding = (r: unknown): RecoveryBindingPart => {
	if (!head(r, 'ssss')) throw new ContentDecodeError('malformed recovery_binding envelope');
	return { kind: 'recovery_binding', secretRef: r[0], candidate: r[1], userHash: r[2], signatureB64: r[3], ...tailOf(r, 4) };
};

const decodeRecoveryInvite = (r: unknown): RecoveryInvitePart => {
	if (!head(r, 'ssn')) throw new ContentDecodeError('malformed recovery_invite envelope');
	return { kind: 'recovery_invite', inviteId: r[0], deployment: r[1], createdAt: r[2], ...tailOf(r, 3) };
};

const decodeRecoveryInviteReply = (r: unknown): RecoveryInviteReplyPart => {
	if (!head(r, 'ssssn')) throw new ContentDecodeError('malformed recovery_invite_reply envelope');
	return {
		kind: 'recovery_invite_reply',
		inviteId: r[0],
		answer: r[1],
		metaAddress: r[2],
		proofB64: r[3],
		createdAt: r[4],
		...tailOf(r, 5),
	};
};

/** Parses wire JSON (canonical or legacy) into parts. Throws ContentDecodeError. */
export const decodeContent = (json: string): ContentPart[] => {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new ContentDecodeError('content is not JSON');
	}
	return decodeValue(value);
};

/**
 * Flat text of a message. Attachments contribute nothing: they render as
 * their own element in the bubble, and repeating the filename as body text
 * printed it twice. Use attachmentLabel for previews that need a word.
 */
export const contentToText = (parts: ContentPart[]): string =>
	parts
		.map((p) => {
			if (p.kind === 'text') return p.text;
			if (p.kind === 'quote') return ''; // the quote is context, not the author's words
			// Attachments render as their own element in the bubble; naming them
			// here too would print the filename twice under the picture.
			if (p.kind === 'file' || p.kind === 'image' || p.kind === 'video') return '';
			if (p.kind === 'checkpoint') return ''; // renders as its own marker
			if (isRecoveryPart(p)) return RECOVERY_LABELS[p.kind];
			return `[${p.type}]`;
		})
		.filter(Boolean)
		.join('\n');

/** One-line label for a message in a preview (reply strip, quote, chat list). */
export const previewText = (parts: ContentPart[]): string => {
	const text = contentToText(parts);
	if (text) return text;
	const media = parts.find((p) => p.kind === 'image' || p.kind === 'video' || p.kind === 'file');
	if (media) {
		const icon = media.kind === 'image' ? '🖼' : media.kind === 'video' ? '🎬' : '📄';
		return `${icon} ${media.name}`;
	}
	if (parts.some((p) => p.kind === 'checkpoint')) return '🔏 checkpoint';
	return '';
};
