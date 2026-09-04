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

/** A typed value this build does not render yet (e.g. "image" before the
 * file transport lands). Preserved verbatim so re-encoding loses nothing. */
export interface UnknownPart {
	kind: 'unknown';
	type: string;
	value: unknown;
}

export type ContentPart = TextPart | QuotePart | FilePart | ImagePart | VideoPart | UnknownPart;

export class ContentDecodeError extends Error {}

const encodePart = (part: ContentPart): unknown => {
	switch (part.kind) {
		case 'text':
			return part.text;
		case 'quote':
			return { quote: [part.authorHash, part.messageId, part.signHash, encodeValue(part.snapshot)] };
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
					part.mimeType, part.createdAt, part.fileId, part.encSecretB64,
					part.durationSeconds || 0,
				],
			};
		case 'unknown':
			return { [part.type]: part.value };
	}
};

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
				const im = obj[type];
				if (!Array.isArray(im) || im.length < 9 || typeof im[7] !== 'string' || typeof im[8] !== 'string') {
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
					fileId: im[7],
					encSecretB64: im[8],
				};
				return type === 'video'
					? [{ kind: 'video', ...media, durationSeconds: Math.max(0, Math.round(Number(im[9]))) || 0 }]
					: [{ kind: 'image', ...media }];
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
			return [{ kind: 'unknown', type, value: obj[type] }];
		}
	}

	throw new ContentDecodeError(`unrecognized content shape: ${JSON.stringify(value)?.slice(0, 80)}`);
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
	return '';
};
