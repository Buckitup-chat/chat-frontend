// A file on the read path is the uploader's: its manifest and every chunk's
// row must verify, and each chunk's bytes must be the ones its row signs.
// Real ML-DSA-87 keys and AES-GCM; only the transport is faked, and the fake
// answers as chat does — binary columns as unpadded base64 (the hex-to-base64
// shape adapter), integers and booleans as the shape's strings.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { signFields, toBase64, fromBase64 } from '@/lib/pq/signature';
import { chunkDataHash, encryptChunk, generateEncSecret } from '@/lib/pq/fileCrypto';

// The chunk cache as chunkCache.ts keeps it: bytes under the hash they were stored with.
const cache = new Map<string, { bytes: Uint8Array; dataHash: string }>();
const cachePuts: string[] = [];
// The app's own key lookup, for the calls that pass no resolver of their own.
vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null }));

vi.mock('@/lib/data/chunkCache', () => ({
	getCachedChunk: async (fileId: string, i: number, dataHash: string) => {
		const rec = cache.get(`${fileId}:${i}`);
		return rec && rec.dataHash === dataHash ? rec.bytes : null;
	},
	putCachedChunk: async (fileId: string, i: number, bytes: Uint8Array, dataHash: string) => {
		cachePuts.push(`${fileId}:${i}`);
		cache.set(`${fileId}:${i}`, { bytes, dataHash });
	},
	requestPersistentStorage: () => {},
}));

const { downloadFile, fileAvailability } = await import('@/lib/data/fileTransfer');
const { FileVerificationError, readVerifiedFile, verifyManifest } = await import('@/lib/data/fileIntegrity');

const UPLOADER = 'u_' + 'a'.repeat(128);
const FILE_ID = 'f_' + '0192aaaa00007000800000000000000a'.slice(0, 32);
const keys = ml_dsa87.keygen(new Uint8Array(32).fill(7));
const PKEY = toBase64(keys.publicKey);
// Another account, with valid keys of its own.
const MALLORY = 'u_' + 'e'.repeat(128);
const malloryKeys = ml_dsa87.keygen(new Uint8Array(32).fill(9));
const cards: Record<string, string> = { [UPLOADER]: PKEY, [MALLORY]: toBase64(malloryKeys.publicKey) };
const resolveSignPkey = async (hash: string) => cards[hash] ?? null;
const unpadded = (b64: string) => b64.replace(/=+$/, '');

type Row = Record<string, unknown>;

/** Uploads as uploadFile does: each chunk encrypted and its row signed, then the manifest over the rows' signatures. */
const makeFile = async (plains: string[], secret = generateEncSecret(), signer = { hash: UPLOADER, secretKey: keys.secretKey }) => {
	const ts = 1_800_000_000;
	const bytes: Uint8Array[] = [];
	const chunkRows: Row[] = [];
	const signHashes: string[] = [];
	for (const [i, text] of plains.entries()) {
		const encrypted = await encryptChunk(secret, new TextEncoder().encode(text));
		const fields = { chunk_index: i, data_hash: chunkDataHash(encrypted), file_id: FILE_ID, owner_timestamp: ts, size: encrypted.length, uploader_hash: signer.hash };
		const sign = signFields(fields, signer.secretKey);
		signHashes.push(toBase64(sha3_512(fromBase64(sign))));
		bytes.push(encrypted);
		chunkRows.push({ ...fields, sign_b64: sign });
	}
	const manifest = {
		chunk_count: plains.length, chunk_sign_hashes: signHashes, chunk_size: 4 * 1024 * 1024, deleted_flag: false,
		file_id: FILE_ID, owner_timestamp: ts, total_size: plains.join('').length, uploader_hash: signer.hash,
	};
	const manifestRow: Row = { ...manifest, sign_b64: signFields(manifest as never, signer.secretKey) };
	return { secret, secretB64: toBase64(secret), bytes, chunkRows, manifestRow, plain: plains.join('') };
};

/** A row as the shape serves it. */
const onWire = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
	if (k === 'sign_b64') return [k, unpadded(v as string)];
	if (Array.isArray(v)) return [k, v.map((el) => unpadded(el as string))];
	if (typeof v === 'boolean') return [k, v ? 't' : 'f'];
	if (typeof v === 'number') return [k, String(v)];
	return [k, v];
}));

let server: { manifest: Row | null; chunkRows: Row[]; bytes: Uint8Array[]; chunkShapeDown?: boolean };
let shapeReads: Record<string, number>;
let chunkRequests: number[];

beforeEach(() => {
	cache.clear();
	cachePuts.length = 0;
	chunkRequests = [];
	shapeReads = {};
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = decodeURIComponent(typeof input === 'string' ? input : input.toString());
		const shape = (rows: Row[]) => new Response(JSON.stringify(rows.map((value) => ({ value }))), { status: 200 });
		const table = /\/shapes\?table=(\w+)&/.exec(url)?.[1];
		if (table) shapeReads[table] = (shapeReads[table] ?? 0) + 1;
		if (table === 'files') return shape(server.manifest ? [onWire(server.manifest)] : []);
		if (table === 'file_chunks') return server.chunkShapeDown ? new Response(null, { status: 500 }) : shape(server.chunkRows.map(onWire));
		const m = url.match(/\/file_chunk\/[^/]+\/(\d+)$/);
		if (m) {
			const i = Number(m[1]);
			chunkRequests.push(i);
			return server.bytes[i] ? new Response(server.bytes[i], { status: 200 }) : new Response(null, { status: 404 });
		}
		return new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
});

/** As the chat page asks: for a file in a message UPLOADER sent. */
const download = (secretB64: string) => downloadFile({ fileId: FILE_ID, uploaderHash: UPLOADER, encSecretB64: secretB64, resolveSignPkey });
const availability = (resolve: (hash: string) => Promise<string | null> = resolveSignPkey) => fileAvailability(FILE_ID, UPLOADER, { resolveSignPkey: resolve });
const refusal = async (p: Promise<unknown>) => {
	const e = await p.then(() => null, (err) => err);
	expect(e).toBeInstanceOf(FileVerificationError);
	return e as InstanceType<typeof FileVerificationError>;
};

describe('a file the uploader signed', () => {
	it('downloads to its bytes, and its availability counts the signed chunks', async () => {
		const f = await makeFile(['first ', 'second ', 'third']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		expect(new TextDecoder().decode(await download(f.secretB64))).toBe(f.plain);
		expect(await availability()).toEqual({ present: 3, total: 3, unknown: false, deleted: false });
	});

	it('verifies a manifest whose chunk signature hashes arrive unpadded, as the shape serves them', async () => {
		const f = await makeFile(['only']);
		const manifest = await verifyManifest(FILE_ID, UPLOADER, onWire(f.manifestRow), resolveSignPkey);
		expect(manifest.chunkCount).toBe(1);
	});
});

describe('a manifest changed without its signature', () => {
	it('with another chunk count: refused by the download and the availability check, before any chunk is asked for', async () => {
		const f = await makeFile(['a', 'b', 'c']);
		server = { manifest: { ...f.manifestRow, chunk_count: 2 }, chunkRows: f.chunkRows, bytes: f.bytes };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
		expect((await refusal(availability())).kind).toBe('invalid');
		expect(chunkRequests).toEqual([]);
	});

	it('with a shorter chunk list kept consistent: refused by its signature alone', async () => {
		const f = await makeFile(['a', 'b', 'c']);
		const listed = f.manifestRow.chunk_sign_hashes as string[];
		server = { manifest: { ...f.manifestRow, chunk_count: 2, chunk_sign_hashes: listed.slice(0, 2) }, chunkRows: f.chunkRows, bytes: f.bytes };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
		expect(chunkRequests).toEqual([]);
	});

	it('with deleted_flag flipped: refused, not reported as deleted', async () => {
		const f = await makeFile(['a']);
		server = { manifest: { ...f.manifestRow, deleted_flag: true }, chunkRows: f.chunkRows, bytes: f.bytes };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
		expect((await refusal(availability())).kind).toBe('invalid');
		expect(chunkRequests).toEqual([]);
	});

	it('waits, rather than refuses, while the uploader\'s card has not arrived', async () => {
		const f = await makeFile(['a']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		const e = await refusal(downloadFile({ fileId: FILE_ID, uploaderHash: UPLOADER, encSecretB64: f.secretB64, resolveSignPkey: async () => null }));
		expect(e.kind).toBe('unavailable');
		expect(await availability(async () => null)).toMatchObject({ unknown: true });
	});
});

describe('chunks out of place', () => {
	it('chunk 1\'s bytes served for index 0: fails on chunk 0, naming it, fetches no further and caches nothing', async () => {
		const f = await makeFile(['zero', 'one', 'two']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: [f.bytes[1], f.bytes[1], f.bytes[2]] };
		const e = await refusal(download(f.secretB64));
		expect(e).toMatchObject({ kind: 'invalid', chunkIndex: 0 });
		expect(chunkRequests).toEqual([0]);
		expect(cachePuts).toEqual([]);
	});

	it('a chunk row moved to another index: refused', async () => {
		const f = await makeFile(['zero', 'one']);
		const moved = { ...f.chunkRows[1], chunk_index: 0 };
		server = { manifest: f.manifestRow, chunkRows: [moved, f.chunkRows[1]], bytes: [f.bytes[1], f.bytes[1]] };
		expect(await refusal(download(f.secretB64))).toMatchObject({ kind: 'invalid', chunkIndex: 0 });
		expect(chunkRequests).toEqual([]);
	});

	it('a row the uploader signed for another upload of this file and index: refused, as the manifest does not list it', async () => {
		const f = await makeFile(['zero', 'one']);
		const other = await makeFile(['ZERO', 'one'], f.secret);
		server = { manifest: f.manifestRow, chunkRows: [other.chunkRows[0], f.chunkRows[1]], bytes: [other.bytes[0], f.bytes[1]] };
		expect(await refusal(download(f.secretB64))).toMatchObject({ kind: 'invalid', chunkIndex: 0 });
		expect(chunkRequests).toEqual([]);
	});

	it('a row whose data hash was swapped under its own signature: refused', async () => {
		const f = await makeFile(['zero', 'one']);
		const swapped = { ...f.chunkRows[0], data_hash: f.chunkRows[1].data_hash };
		server = { manifest: f.manifestRow, chunkRows: [swapped, f.chunkRows[1]], bytes: [f.bytes[1], f.bytes[1]] };
		expect(await refusal(download(f.secretB64))).toMatchObject({ kind: 'invalid', chunkIndex: 0 });
		expect(chunkRequests).toEqual([]);
	});

	it('a chunk whose row has not arrived: not verifiable yet, not refused', async () => {
		const f = await makeFile(['zero', 'one']);
		server = { manifest: f.manifestRow, chunkRows: [f.chunkRows[0]], bytes: f.bytes };
		expect(await refusal(download(f.secretB64))).toMatchObject({ kind: 'unavailable', chunkIndex: 1 });
	});

	it('a cached chunk stored under another hash is fetched again and overwritten', async () => {
		const f = await makeFile(['zero', 'one']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		cache.set(`${FILE_ID}:0`, { bytes: f.bytes[1], dataHash: chunkDataHash(f.bytes[1]) });
		expect(new TextDecoder().decode(await download(f.secretB64))).toBe('zeroone');
		expect(chunkRequests).toEqual([0, 1]);
		expect(cache.get(`${FILE_ID}:0`)).toEqual({ bytes: f.bytes[0], dataHash: chunkDataHash(f.bytes[0]) });
	});

	it('a cached chunk under its signed hash is read without a fetch', async () => {
		const f = await makeFile(['zero']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: [] };
		cache.set(`${FILE_ID}:0`, { bytes: f.bytes[0], dataHash: chunkDataHash(f.bytes[0]) });
		expect(new TextDecoder().decode(await download(f.secretB64))).toBe('zero');
		expect(chunkRequests).toEqual([]);
	});
});

describe('a file signed by someone other than its sender', () => {
	it('another account re-signs the manifest and rows to reorder the chunks: refused, not played in its order', async () => {
		const f = await makeFile(['AAAA', 'BBBB']);
		// Mallory does not know the secret; she re-signs rows that point at the real bytes in her order.
		const forged = await makeFile(['x', 'y'], undefined, { hash: MALLORY, secretKey: malloryKeys.secretKey });
		const rows = [1, 0].map((src, i) => {
			const fields = { ...f.chunkRows[src], chunk_index: i, uploader_hash: MALLORY };
			delete (fields as Row).sign_b64;
			return { ...fields, sign_b64: signFields(fields as never, malloryKeys.secretKey) };
		});
		const manifest = { ...forged.manifestRow, chunk_sign_hashes: rows.map((r) => toBase64(sha3_512(fromBase64(r.sign_b64 as string)))) };
		delete (manifest as Row).sign_b64;
		const manifestRow = { ...manifest, sign_b64: signFields(manifest as never, malloryKeys.secretKey) };
		server = { manifest: manifestRow, chunkRows: rows, bytes: [f.bytes[1], f.bytes[0]] };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
		expect((await refusal(availability())).kind).toBe('invalid');
		expect(chunkRequests).toEqual([]);
	});

	it('a manifest naming the sender but signed with another key: refused', async () => {
		const f = await makeFile(['AAAA']);
		const manifest = { ...f.manifestRow };
		delete (manifest as Row).sign_b64;
		server = { manifest: { ...manifest, sign_b64: signFields(manifest as never, malloryKeys.secretKey) }, chunkRows: f.chunkRows, bytes: f.bytes };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
	});
});

describe('availability', () => {
	it('counts only the chunk rows the manifest lists', async () => {
		const f = await makeFile(['zero', 'one', 'two']);
		const injected = { ...f.chunkRows[0], chunk_index: 2, sign_b64: f.chunkRows[0].sign_b64 };
		server = { manifest: f.manifestRow, chunkRows: [f.chunkRows[0], f.chunkRows[1], injected, { ...f.chunkRows[1], chunk_index: 5 }], bytes: f.bytes };
		expect(await availability()).toEqual({ present: 2, total: 3, unknown: false, deleted: false });
	});
});

describe('reading a file', () => {
	it('keeps the total of the manifest when the chunk rows cannot be read', async () => {
		const f = await makeFile(['zero', 'one']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes, chunkShapeDown: true };
		expect(await availability()).toEqual({ present: 0, total: 2, unknown: false, deleted: false });
	});

	it('verifies once for callers asking at the same time, as the availability check and the download of an image do', async () => {
		const f = await makeFile(['zero']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		const [a, b] = await Promise.all([fileAvailability(FILE_ID, UPLOADER), fileAvailability(FILE_ID, UPLOADER)]);
		expect(a).toEqual(b);
		expect(shapeReads).toEqual({ files: 1, file_chunks: 1 });
	});

	it('looks for a late chunk row again once for every index waiting, no sooner than 2 s after the last look', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
		try {
			const f = await makeFile(['zero', 'one', 'two']);
			server = { manifest: f.manifestRow, chunkRows: [f.chunkRows[0]], bytes: f.bytes };
			const file = (await readVerifiedFile(FILE_ID, UPLOADER, { resolveSignPkey }))!;
			server.chunkRows = f.chunkRows;
			const waiting = Promise.all([file.hashes.expected(1), file.hashes.expected(2)]);
			await vi.advanceTimersByTimeAsync(1000);
			expect(shapeReads.file_chunks).toBe(1);
			await vi.advanceTimersByTimeAsync(1000);
			expect(await waiting).toEqual([chunkDataHash(f.bytes[1]), chunkDataHash(f.bytes[2])]);
			expect(shapeReads.file_chunks).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

});
