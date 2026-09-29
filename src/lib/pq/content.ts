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

export interface TextPart {
	kind: 'text';
	text: string;
}

export interface QuotePart {
	kind: 'quote';
	authorHash: string;
	messageId: string;
	signHash: string;
	/** Frozen at citation time; renders independently of the original row. */
	snapshot: ContentPart[];
}

/** Out-of-band file attachment (07 §"file"): the bytes live as encrypted
 * chunks on the device; the envelope carries the reference and the key. */
export interface FilePart {
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
export interface ImagePart {
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
export interface CheckpointPart {
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
	/** Positions past split_proof, from a newer build: kept, so re-encoding loses nothing. */
	rest?: unknown[];
}

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
			return { quote: [part.authorHash, part.messageId, part.signHash, encodeValue(part.snapshot.map(quotable))] };
		case 'file':
			return { file: [part.name, part.size, part.mimeType, part.createdAt, part.fileId, part.encSecretB64] };
		case 'image':
			return {
				image: [
					part.widthAspect, part.heightAspect, part.thumbHashB64, part.name, part.size,
					part.mimeType, part.createdAt, part.fileId, part.encSecretB64,
				],
			};
		case 'video':
			return {
				video: [
					part.widthAspect, part.heightAspect, part.thumbHashB64, part.name, part.size,
					part.mimeType, part.createdAt, part.durationSeconds || 0,
					part.fileId, part.encSecretB64,
				],
			};
		case 'checkpoint':
			return {
				checkpoint: [
					part.version, part.reducerVersion, part.treeVersion,
					part.frontierRoot, part.viewRoot, part.frontier, part.createdAt,
				],
			};
		case 'recovery_share':
			return {
				recovery_share: [
					part.secretRef, part.version, part.threshold, part.total, part.shareB64,
					part.createdAt, part.splitId, part.shareIndex, part.splitProof, ...(part.rest ?? []),
				],
			};
		case 'unknown':
			return { [part.type]: part.value };
	}
};

/**
 * What a quote may carry of a part. A recovery share is named, never copied:
 * a reply to the message would otherwise put the share's bytes in a second
 * message, which the share's owner never sent and dropping the share never
 * reaches.
 */
const quotable = (part: ContentPart): ContentPart =>
	part.kind === 'recovery_share' ? { kind: 'text', text: RECOVERY_SHARE_LABEL } : part;

const RECOVERY_SHARE_LABEL = '🔐 recovery share';

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
					}];
				}
				if (im.length < 9 || typeof im[7] !== 'string' || typeof im[8] !== 'string') {
					throw new ContentDecodeError('malformed image envelope');
				}
				return [{ kind: 'image', ...media, fileId: im[7], encSecretB64: im[8] }];
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
				}];
			}
			if (type === 'recovery_share') return [decodeRecoveryShare(obj.recovery_share)];
			return [{ kind: 'unknown', type, value: obj[type] }];
		}
	}

	throw new ContentDecodeError(`unrecognized content shape: ${JSON.stringify(value)?.slice(0, 80)}`);
};

const isInt = (v: unknown): v is number => Number.isInteger(v);

/**
 * Positions 0–7 are required and typed; `split_proof` at 8 may be missing — a
 * share without it is kept and fails its check, rather than taking the whole
 * message down as undecodable. A longer array is accepted and its tail ignored.
 */
const decodeRecoveryShare = (r: unknown): RecoverySharePart => {
	if (
		!Array.isArray(r) || r.length < 8 ||
		typeof r[0] !== 'string' || !isInt(r[1]) || !isInt(r[2]) || !isInt(r[3]) ||
		typeof r[4] !== 'string' || typeof r[5] !== 'number' || typeof r[6] !== 'string' || !isInt(r[7]) ||
		(r.length > 8 && !(Array.isArray(r[8]) && r[8].every((leaf: unknown) => typeof leaf === 'string')))
	) {
		throw new ContentDecodeError('malformed recovery_share envelope');
	}
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
		splitProof: r.length > 8 ? (r[8] as string[]) : [],
		rest: r.slice(9),
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
			if (p.kind === 'recovery_share') return RECOVERY_SHARE_LABEL;
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
