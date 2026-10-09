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

const cache = new Map<string, Uint8Array>();
const cachePuts: string[] = [];
vi.mock('@/lib/data/chunkCache', () => ({
	getCachedChunk: async (fileId: string, i: number) => cache.get(`${fileId}:${i}`) ?? null,
	putCachedChunk: async (fileId: string, i: number, bytes: Uint8Array) => {
		cachePuts.push(`${fileId}:${i}`);
		cache.set(`${fileId}:${i}`, bytes);
	},
	deleteCachedChunk: async (fileId: string, i: number) => {
		cache.delete(`${fileId}:${i}`);
	},
	requestPersistentStorage: () => {},
}));

const { downloadFile, fileAvailability } = await import('@/lib/data/fileTransfer');
const { ChunkHashes, FileVerificationError, verifyManifest } = await import('@/lib/data/fileIntegrity');

const UPLOADER = 'u_' + 'a'.repeat(128);
const FILE_ID = 'f_' + '0192aaaa00007000800000000000000a'.slice(0, 32);
const keys = ml_dsa87.keygen(new Uint8Array(32).fill(7));
const PKEY = toBase64(keys.publicKey);
const resolveSignPkey = async (hash: string) => (hash === UPLOADER ? PKEY : null);
const unpadded = (b64: string) => b64.replace(/=+$/, '');

type Row = Record<string, unknown>;

/** Uploads as uploadFile does: each chunk encrypted and its row signed, then the manifest over the rows' signatures. */
const makeFile = async (plains: string[], secret = generateEncSecret()) => {
	const ts = 1_800_000_000;
	const bytes: Uint8Array[] = [];
	const chunkRows: Row[] = [];
	const signHashes: string[] = [];
	for (const [i, text] of plains.entries()) {
		const encrypted = await encryptChunk(secret, new TextEncoder().encode(text));
		const fields = { chunk_index: i, data_hash: chunkDataHash(encrypted), file_id: FILE_ID, owner_timestamp: ts, size: encrypted.length, uploader_hash: UPLOADER };
		const sign = signFields(fields, keys.secretKey);
		signHashes.push(toBase64(sha3_512(fromBase64(sign))));
		bytes.push(encrypted);
		chunkRows.push({ ...fields, sign_b64: sign });
	}
	const manifest = {
		chunk_count: plains.length, chunk_sign_hashes: signHashes, chunk_size: 4 * 1024 * 1024, deleted_flag: false,
		file_id: FILE_ID, owner_timestamp: ts, total_size: plains.join('').length, uploader_hash: UPLOADER,
	};
	const manifestRow: Row = { ...manifest, sign_b64: signFields(manifest as never, keys.secretKey) };
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

let server: { manifest: Row | null; chunkRows: Row[]; bytes: Uint8Array[] };
let chunkRequests: number[];

beforeEach(() => {
	cache.clear();
	cachePuts.length = 0;
	chunkRequests = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = decodeURIComponent(typeof input === 'string' ? input : input.toString());
		const shape = (rows: Row[]) => new Response(JSON.stringify(rows.map((value) => ({ value }))), { status: 200 });
		if (url.includes('/shapes?table=files&')) return shape(server.manifest ? [onWire(server.manifest)] : []);
		if (url.includes('/shapes?table=file_chunks&')) return shape(server.chunkRows.map(onWire));
		const m = url.match(/\/file_chunk\/[^/]+\/(\d+)$/);
		if (m) {
			const i = Number(m[1]);
			chunkRequests.push(i);
			return server.bytes[i] ? new Response(server.bytes[i], { status: 200 }) : new Response(null, { status: 404 });
		}
		return new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
});

const download = (secretB64: string) => downloadFile({ fileId: FILE_ID, encSecretB64: secretB64, resolveSignPkey });
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
		expect(await fileAvailability(FILE_ID, { resolveSignPkey })).toEqual({ present: 3, total: 3, unknown: false, deleted: false });
	});

	it('verifies a manifest whose chunk signature hashes arrive unpadded, as the shape serves them', async () => {
		const f = await makeFile(['only']);
		const manifest = await verifyManifest(FILE_ID, onWire(f.manifestRow), resolveSignPkey);
		expect(manifest.chunkCount).toBe(1);
	});
});

describe('a manifest changed without its signature', () => {
	it('with another chunk count: refused by the download and the availability check, before any chunk is asked for', async () => {
		const f = await makeFile(['a', 'b', 'c']);
		server = { manifest: { ...f.manifestRow, chunk_count: 2 }, chunkRows: f.chunkRows, bytes: f.bytes };
		expect((await refusal(download(f.secretB64))).kind).toBe('invalid');
		expect((await refusal(fileAvailability(FILE_ID, { resolveSignPkey }))).kind).toBe('invalid');
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
		expect((await refusal(fileAvailability(FILE_ID, { resolveSignPkey }))).kind).toBe('invalid');
		expect(chunkRequests).toEqual([]);
	});

	it('waits, rather than refuses, while the uploader\'s card has not arrived', async () => {
		const f = await makeFile(['a']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		const e = await refusal(downloadFile({ fileId: FILE_ID, encSecretB64: f.secretB64, resolveSignPkey: async () => null }));
		expect(e.kind).toBe('unavailable');
		expect(await fileAvailability(FILE_ID, { resolveSignPkey: async () => null })).toMatchObject({ unknown: true });
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

	it('a cached chunk that is not the signed one is evicted and fetched again', async () => {
		const f = await makeFile(['zero', 'one']);
		server = { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: f.bytes };
		cache.set(`${FILE_ID}:0`, f.bytes[1]);
		expect(new TextDecoder().decode(await download(f.secretB64))).toBe('zeroone');
		expect(chunkRequests).toEqual([0, 1]);
		expect(cache.get(`${FILE_ID}:0`)).toEqual(f.bytes[0]);
	});
});

describe('the hash list the video worker gets', () => {
	it('gives each index its signed hash, null for a row not here, false for a refused row', async () => {
		const f = await makeFile(['zero', 'one', 'two']);
		server = { manifest: f.manifestRow, chunkRows: [f.chunkRows[0], { ...f.chunkRows[2], data_hash: f.chunkRows[0].data_hash }], bytes: f.bytes };
		const manifest = await verifyManifest(FILE_ID, onWire(f.manifestRow), resolveSignPkey);
		const list = await new ChunkHashes(manifest).list();
		expect(list).toEqual([chunkDataHash(f.bytes[0]), null, false]);
	});
});
