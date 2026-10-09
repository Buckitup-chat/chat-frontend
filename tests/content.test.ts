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

describe('video envelope (§1.4)', () => {
	const video = {
		kind: 'video' as const,
		widthAspect: 16, heightAspect: 9, thumbHashB64: 'YTg4', name: 'clip.mp4',
		size: 52_428_800, mimeType: 'video/mp4', createdAt: 1715000000,
		fileId: 'f_' + '2'.repeat(32), encSecretB64: 'c2VjcmV0',
		durationSeconds: 127,
	};

	// 07 registry: duration sits with the media metadata at position 7; the
	// transport refs (file_id, enc_secret) are the tail of the array.
	it('round-trips duration at position 7, refs at the tail', () => {
		const wire = encodeContent([video]);
		expect(wire).toContain(`,127,"${video.fileId}","c2VjcmV0"]`);
		expect(decodeContent(wire)[0]).toEqual(video);
	});

	it('a malformed envelope with refs at the image positions is rejected', () => {
		const oldOrder = `{"video":[16,9,"YTg4","clip.mp4",52428800,"video/mp4",1715000000,"${video.fileId}","c2VjcmV0",127]}`;
		expect(() => decodeContent(oldOrder)).toThrow(ContentDecodeError);
	});

	it('an unknown duration encodes as 0, not undefined', () => {
		const wire = encodeContent([{ ...video, durationSeconds: 0 }]);
		expect(wire).toContain(`,0,"${video.fileId}","c2VjcmV0"]`);
	});
});

// 07: positional fields are append-only. A newer build's tail must survive a
// decode → encode here, or quoting its message strips the field it added.
describe('T-CONTENT-APPEND-ONLY: a longer envelope round-trips intact', () => {
	const ref = 'f_' + '3'.repeat(32);
	const sign = 'dms_' + 'a'.repeat(128);
	const mid = 'dmsg_0190a3b2-1c4d-7e5f-8a6b-7c8d9e0f1a2b';
	const envelopes = {
		file: ['a.pdf', 1, 'application/pdf', 1715000000, ref, 'c2VjcmV0'],
		image: [16, 9, 'YTg4', 'shot.png', 5, 'image/png', 1715000000, ref, 'c2VjcmV0'],
		video: [16, 9, 'YTg4', 'clip.mp4', 5, 'video/mp4', 1715000000, 127, ref, 'c2VjcmV0'],
		quote: ['u_a', 'm', 's', 'cited'],
		checkpoint: [1, 'r1', 't1', 'froot', 'vroot', { [mid]: sign }, 1715000000],
	};

	for (const [type, known] of Object.entries(envelopes)) {
		it(`${type}: keeps the fields past the known layout`, () => {
			const wire = JSON.stringify({ [type]: [...known, 'a future field', { nested: 1 }] });
			expect(encodeContent(decodeContent(wire))).toBe(wire);
		});

		it(`${type}: the known layout gains no tail`, () => {
			const wire = JSON.stringify({ [type]: known });
			expect(decodeContent(wire)[0]).not.toHaveProperty('rest');
			expect(encodeContent(decodeContent(wire))).toBe(wire);
		});
	}

	it('a quoted newer message keeps its tail inside the snapshot', () => {
		const newer = decodeContent(JSON.stringify({ video: [...envelopes.video, 'a future field'] }));
		const reply = encodeContent([{ kind: 'quote', authorHash: 'u_a', messageId: 'm', signHash: 's', snapshot: newer }]);
		expect(JSON.parse(reply).quote[3].video.at(-1)).toBe('a future field');
	});
});

describe('T-CONTENT-RECOVERY-SHARE: a guardian share envelope', () => {
	const nodeSet = { threshold: 2, nodes: ['n_' + '0'.repeat(32) + '@https://a.example/recovery/node', 'n_' + '1'.repeat(32) + '@https://b.example/recovery/node'] };
	const part = {
		kind: 'recovery_share' as const,
		secretRef: 'eip155:11155111:0xd9ff/0x9f3c',
		version: 1,
		threshold: 2,
		total: 3,
		shareB64: 'CAFxyz',
		createdAt: 1_715_000_000,
		splitId: '4f1c'.repeat(8),
		shareIndex: 2,
		splitProof: ['leafA', 'leafB', 'leafC'],
		nodeSet,
	};
	const head = [part.secretRef, 1, 2, 3, 'CAFxyz', 1_715_000_000, part.splitId, 2];

	it('round-trips at the registry positions, the node set last', () => {
		const json = encodeContent([part]);
		expect(JSON.parse(json)).toEqual({ recovery_share: [...head, ['leafA', 'leafB', 'leafC'], [2, nodeSet.nodes]] });
		expect(decodeContent(json)).toEqual([part]);
	});

	it('accepts a longer array and keeps its tail; takes a missing proof or node set as none, which no check passes', () => {
		const wire = [...head, ['leafA'], [2, nodeSet.nodes], 'a future field'];
		const decoded = decodeContent(JSON.stringify({ recovery_share: wire }));
		expect(decoded[0]).toMatchObject({ splitProof: ['leafA'], nodeSet, rest: ['a future field'] });
		expect(JSON.parse(encodeContent(decoded)).recovery_share).toEqual(wire);
		expect(decodeContent(JSON.stringify({ recovery_share: head }))[0]).toMatchObject({ splitProof: [], nodeSet: null });
		expect(decodeContent(JSON.stringify({ recovery_share: [...head, ['leafA']] }))[0]).toMatchObject({ nodeSet: null });
	});

	it('refuses a node set of more than its two elements: the root covers only those', () => {
		const wire = [...head, ['leafA'], [2, nodeSet.nodes, 'unauthenticated']];
		expect(() => decodeContent(JSON.stringify({ recovery_share: wire }))).toThrow(ContentDecodeError);
	});

	it('takes a null proof as none, like a null node set', () => {
		expect(decodeContent(JSON.stringify({ recovery_share: [...head, null, [2, nodeSet.nodes]] }))[0]).toMatchObject({ splitProof: [], nodeSet });
	});

	it('keeps a newer tail behind a missing node set in place', () => {
		const wire = [...head, ['leafA'], null, 'a future field'];
		const decoded = decodeContent(JSON.stringify({ recovery_share: wire }));
		expect(decoded[0]).toMatchObject({ nodeSet: null, rest: ['a future field'] });
		expect(JSON.parse(encodeContent(decoded)).recovery_share).toEqual(wire);
	});

	it('refuses a malformed envelope rather than guessing its fields', () => {
		const bad = [
			[part.secretRef, '1', 2, 3, 'CAFxyz', 1, part.splitId, 2],
			[part.secretRef, 1, 2.5, 3, 'CAFxyz', 1, part.splitId, 2],
			[part.secretRef, 1, 2, 3, 'CAFxyz', 1, part.splitId],
			[...head, 'not a list'],
			[...head, [1, 2]],
			[...head, ['leafA'], 'not a node set'],
			[...head, ['leafA'], [2, [1]]],
		];
		for (const wire of bad) expect(() => decodeContent(JSON.stringify({ recovery_share: wire }))).toThrow(ContentDecodeError);
	});

	it('shows as a recovery share, never as an empty bubble', () => {
		expect(contentToText([part])).toBe('🔐 recovery share');
		expect(previewText([part])).toBe('🔐 recovery share');
	});

	it('is named in a quote, never copied: a reply must not carry the share', () => {
		const reply = encodeContent([{ kind: 'quote', authorHash: 'u_a', messageId: 'm', signHash: 's', snapshot: [part] }, { kind: 'text', text: 'thanks' }]);
		expect(reply).not.toContain('CAFxyz');
		expect(reply).not.toContain('leafA');
		expect(reply).toContain('🔐 recovery share');
	});
});

describe('T-CONTENT-QUOTE-ALLOWLIST: what a quote copies', () => {
	it('names a type this build does not know instead of copying it: it may hold a key', () => {
		const unknown = decodeContent(JSON.stringify({ review_list_key: ['SECRETPASSWORD'] }));
		const reply = encodeContent([{ kind: 'quote', authorHash: 'u_a', messageId: 'm', signHash: 's', snapshot: unknown }]);
		expect(reply).not.toContain('SECRETPASSWORD');
		expect(reply).toContain('[review_list_key]');
	});
});

describe('T-CONTENT-RECOVERY: the other recovery envelopes', () => {
	const nodeSet = { threshold: 2, nodes: ['n_' + '0'.repeat(32) + '@https://a.example/recovery/node', 'n_' + '1'.repeat(32) + '@https://b.example/recovery/node'] };
	const parts = {
		recovery_share_return: {
			kind: 'recovery_share_return' as const,
			secretRef: 'eip155:10:0x4590/0x9f3c', version: 1, splitId: '4f1c'.repeat(8), threshold: 2, total: 3, shareIndex: 2,
			round: 4, candidate: '0x7a1b', shareB64: 'CAFxyz', createdAt: 1_715_600_000, splitProof: ['leafA', 'leafB', 'leafC'], nodeSet,
		},
		recovery_binding: { kind: 'recovery_binding' as const, secretRef: 'eip155:10:0x4590/0x9f3c', candidate: '0x7a1b', userHash: 'u_ab12', signatureB64: 'c2ln' },
		recovery_invite: { kind: 'recovery_invite' as const, inviteId: '9b2e'.repeat(8), deployment: 'eip155:10:0x4590' },
		recovery_invite_reply: {
			kind: 'recovery_invite_reply' as const, inviteId: '9b2e'.repeat(8), answer: 'accept', metaAddress: '0x02a1', proofB64: 'cHJvb2Y',
		},
	};
	const wires = {
		recovery_share_return: ['eip155:10:0x4590/0x9f3c', 1, '4f1c'.repeat(8), 2, 3, 2, 4, '0x7a1b', 'CAFxyz', 1_715_600_000, ['leafA', 'leafB', 'leafC'], [2, nodeSet.nodes]],
		recovery_binding: ['eip155:10:0x4590/0x9f3c', '0x7a1b', 'u_ab12', 'c2ln'],
		recovery_invite: ['9b2e'.repeat(8), 'eip155:10:0x4590'],
		recovery_invite_reply: ['9b2e'.repeat(8), 'accept', '0x02a1', 'cHJvb2Y'],
	};

	for (const type of Object.keys(parts) as (keyof typeof parts)[]) {
		it(`${type}: round-trips at the registry positions, and keeps a newer tail`, () => {
			const json = encodeContent([parts[type]]);
			expect(JSON.parse(json)).toEqual({ [type]: wires[type] });
			expect(decodeContent(json)).toEqual([parts[type]]);
			const longer = decodeContent(JSON.stringify({ [type]: [...wires[type], 'a future field'] }));
			expect(longer[0]).toMatchObject({ rest: ['a future field'] });
			expect(JSON.parse(encodeContent(longer))[type]).toEqual([...wires[type], 'a future field']);
		});

		it(`${type}: refuses an envelope one field short, or with a field of the wrong type`, () => {
			const short = wires[type].slice(0, -1);
			const wrong = [...wires[type]];
			wrong[0] = 42;
			for (const wire of type === 'recovery_share_return' ? [wires[type].slice(0, 9), wrong] : [short, wrong]) {
				expect(() => decodeContent(JSON.stringify({ [type]: wire }))).toThrow(ContentDecodeError);
			}
		});

		it(`${type}: is named in a quote, never copied`, () => {
			const reply = encodeContent([{ kind: 'quote', authorHash: 'u_a', messageId: 'm', signHash: 's', snapshot: [parts[type]] }]);
			expect(reply).not.toContain(JSON.stringify(wires[type][0]));
			expect(contentToText([parts[type]])).toMatch(/^(🔐|🛡) /);
		});
	}
});
