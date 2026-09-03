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

/** A typed value this build does not render yet (e.g. "image" before the
 * file transport lands). Preserved verbatim so re-encoding loses nothing. */
export interface UnknownPart {
	kind: 'unknown';
	type: string;
	value: unknown;
}

export type ContentPart = TextPart | QuotePart | UnknownPart;

export class ContentDecodeError extends Error {}

const encodePart = (part: ContentPart): unknown => {
	switch (part.kind) {
		case 'text':
			return part.text;
		case 'quote':
			return { quote: [part.authorHash, part.messageId, part.signHash, encodeValue(part.snapshot)] };
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

/** Flat text of a message — what previews, quotes-of-quotes and search see. */
export const contentToText = (parts: ContentPart[]): string =>
	parts
		.map((p) => {
			if (p.kind === 'text') return p.text;
			if (p.kind === 'quote') return ''; // the quote is context, not the author's words
			return `[${p.type}]`;
		})
		.filter(Boolean)
		.join('\n');
