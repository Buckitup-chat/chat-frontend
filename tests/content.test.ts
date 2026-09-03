import { describe, it, expect } from 'vitest';
import { encodeContent, decodeContent, contentToText, previewText, ContentDecodeError } from '@/lib/pq/content';

// Wire-format contract with every other client (07_content_polymorphism.md).
// The acceptance names follow the review's T-CONTENT set.

describe('T-CONTENT-01: canonical bare text', () => {
	it('encodes a single text part as a bare JSON string', () => {
		expect(encodeContent([{ kind: 'text', text: 'hello' }])).toBe('"hello"');
	});

	it('decodes a bare JSON string as text', () => {
		expect(decodeContent('"hello"')).toEqual([{ kind: 'text', text: 'hello' }]);
	});
});

describe('T-CONTENT-02: legacy text stays readable', () => {
	it('decodes the {"type":"text"} form this client used to emit', () => {
		expect(decodeContent('{"type":"text","text":"старое сообщение"}')).toEqual([
			{ kind: 'text', text: 'старое сообщение' },
		]);
	});

	it('never emits the legacy form again', () => {
		const reEncoded = encodeContent(decodeContent('{"type":"text","text":"x"}'));
		expect(reEncoded).toBe('"x"');
	});
});

describe('T-CONTENT-03: composed messages', () => {
	it('round-trips a text-plus-file composition', () => {
		const wire = encodeContent([
			{ kind: 'text', text: 'вот файл' },
			{ kind: 'file', name: 'doc.pdf', size: 1048576, mimeType: 'application/pdf', createdAt: 1715000000, fileId: 'f_' + '1'.repeat(32), encSecretB64: 'AAAA' },
		]);
		const parts = decodeContent(wire);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toEqual({ kind: 'text', text: 'вот файл' });
		expect(parts[1]).toMatchObject({ kind: 'file', name: 'doc.pdf', fileId: 'f_' + '1'.repeat(32) });
		// and the wire stays the canonical positional array
		expect(wire).toContain('"file":["doc.pdf",1048576');
	});

	it('rejects a malformed file envelope', () => {
		expect(() => decodeContent('{"file":["only-name"]}')).toThrow(ContentDecodeError);
	});

	it('flattens nested grouping arrays for a vertical render', () => {
		expect(decodeContent('["a",["b","c"]]').map((p) => (p as { text: string }).text)).toEqual(['a', 'b', 'c']);
	});

	it('preserves an unrendered typed value verbatim through a re-encode', () => {
		const wire = '{"image":[16,9,"th","p.jpg",5242880,"image/jpeg",1715000000,"f_01","enc"]}';
		expect(encodeContent(decodeContent(wire))).toBe(wire);
	});
});

describe('quote envelope', () => {
	const quote = {
		kind: 'quote' as const,
		authorHash: 'u_' + 'a'.repeat(128),
		messageId: 'dmsg_1',
		signHash: 'dms_' + 'b'.repeat(128),
		snapshot: [{ kind: 'text' as const, text: 'Схему пришли до четверга' }],
	};

	it('round-trips a reply (quote + text)', () => {
		const wire = encodeContent([quote, { kind: 'text', text: 'Уже в очереди' }]);
		const parts = decodeContent(wire);
		expect(parts[0]).toEqual(quote);
		expect(parts[1]).toEqual({ kind: 'text', text: 'Уже в очереди' });
	});

	// §1.2 "цитата внутри цитаты": the snapshot is canonical content, so a
	// cited reply nests without any special casing.
	it('nests: quoting a message that itself contains a quote', () => {
		const outer = {
			kind: 'quote' as const,
			authorHash: quote.authorHash,
			messageId: 'dmsg_2',
			signHash: 'dms_' + 'c'.repeat(128),
			snapshot: [quote, { kind: 'text' as const, text: 'Уже в очереди' }],
		};
		const parts = decodeContent(encodeContent([outer, { kind: 'text', text: 'ок' }]));
		expect(parts[0]).toEqual(outer);
		const inner = (parts[0] as typeof outer).snapshot[0];
		expect(inner).toEqual(quote);
	});

	// The snapshot is the whole point: the quote must render with no access
	// to the original row (invariants: never arrived / deleted / edited away).
	it('carries the cited content inside itself', () => {
		const parts = decodeContent(encodeContent([quote]));
		expect(contentToText((parts[0] as typeof quote).snapshot)).toBe('Схему пришли до четверга');
	});

	it('rejects a malformed quote instead of rendering a guess', () => {
		expect(() => decodeContent('{"quote":["only-author"]}')).toThrow(ContentDecodeError);
	});
});

describe('error handling', () => {
	it('rejects non-JSON content', () => {
		expect(() => decodeContent('not json')).toThrow(ContentDecodeError);
	});

	it('rejects a multi-key object — the type must be unambiguous', () => {
		expect(() => decodeContent('{"a":1,"b":2}')).toThrow(ContentDecodeError);
	});
});

describe('contentToText', () => {
	it('flattens text and labels unrendered types', () => {
		expect(
			contentToText([
				{ kind: 'text', text: 'смотри' },
				{ kind: 'unknown', type: 'image', value: [] },
			]),
		).toBe('смотри\n[image]');
	});
});

describe('image envelope (§1.3)', () => {
	const image = {
		kind: 'image' as const,
		widthAspect: 16, heightAspect: 9, thumbHashB64: 'YTg4', name: 'shot.png',
		size: 5_242_880, mimeType: 'image/png', createdAt: 1715000000,
		fileId: 'f_' + '1'.repeat(32), encSecretB64: 'c2VjcmV0',
	};

	it('round-trips in the canonical positional order', () => {
		const wire = encodeContent([image]);
		expect(wire).toContain('"image":[16,9,"YTg4","shot.png",5242880');
		expect(decodeContent(wire)[0]).toEqual(image);
	});

	it('rejects a malformed image envelope', () => {
		expect(() => decodeContent('{"image":[16,9]}')).toThrow(ContentDecodeError);
	});

	// The picture renders as its own element; naming it as body text printed
	// the filename twice under the image.
	it('contributes no body text', () => {
		expect(contentToText([image, { kind: 'text', text: 'вот схема' }])).toBe('вот схема');
		expect(contentToText([image])).toBe('');
	});

	it('previewText still labels an attachment-only message', () => {
		expect(previewText([image])).toBe('🖼 shot.png');
		expect(previewText([{ kind: 'file', name: 'a.pdf', size: 1, mimeType: 'application/pdf', createdAt: 0, fileId: 'f_1', encSecretB64: 'x' }])).toBe('📄 a.pdf');
		expect(previewText([image, { kind: 'text', text: 'подпись' }])).toBe('подпись');
	});
});
