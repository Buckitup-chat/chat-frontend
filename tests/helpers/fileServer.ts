// A file as an uploader publishes it, and a server that serves it the way
// chat does: the manifest and chunk rows through /shapes (binary columns as
// unpadded base64, integers and booleans as strings), the bytes through
// /file_chunk. Real ML-DSA-87 signatures and AES-GCM; only the transport is
// faked. `offline` makes every request fail as fetch does with no network.
import { vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { signFields, toBase64, fromBase64 } from '@buckitup/pq-client/signature';
import { chunkDataHash, encryptChunk, generateEncSecret } from '@buckitup/pq-client/fileCrypto';

type Row = Record<string, unknown>;

export const UPLOADER = 'u_' + 'a'.repeat(128);
const keys = ml_dsa87.keygen(new Uint8Array(32).fill(7));
export const cards: Record<string, string> = { [UPLOADER]: toBase64(keys.publicKey) };
export const resolveSignPkey = async (hash: string) => cards[hash] ?? null;

const unpadded = (b64: string) => b64.replace(/=+$/, '');
const sign = (fields: Row) => signFields(fields as never, keys.secretKey);

export interface PublishedFile {
	fileId: string;
	secretB64: string;
	plain: string;
	bytes: Uint8Array[];
	chunkRows: Row[];
	manifestRow: Row;
	/** The manifest after the uploader deletes the file (pq_files §7). */
	tombstone: Row;
	/** The file as a message carries it. */
	part: { kind: string; fileId: string; uploaderHash: string; encSecretB64: string; name: string; size: number; mimeType: string; createdAt: number };
}

/**
 * Uploads as uploadFile does: each chunk encrypted and its row signed, then
 * the manifest over the rows' signatures. The chunks in `foreign` are
 * encrypted under another secret, as a faulty uploader would.
 */
export const publishFile = async (fileId: string, plains: string[], foreign: number[] = []): Promise<PublishedFile> => {
	const secret = generateEncSecret();
	const otherSecret = generateEncSecret();
	const ts = 1_800_000_000;
	const bytes: Uint8Array[] = [];
	const chunkRows: Row[] = [];
	const signHashes: string[] = [];
	for (const [i, text] of plains.entries()) {
		const encrypted = await encryptChunk(foreign.includes(i) ? otherSecret : secret, new TextEncoder().encode(text));
		const fields = { chunk_index: i, data_hash: chunkDataHash(encrypted), file_id: fileId, owner_timestamp: ts, size: encrypted.length, uploader_hash: UPLOADER };
		const s = sign(fields);
		signHashes.push(toBase64(sha3_512(fromBase64(s))));
		bytes.push(encrypted);
		chunkRows.push({ ...fields, sign_b64: s });
	}
	const plain = plains.join('');
	const manifest = {
		chunk_count: plains.length, chunk_sign_hashes: signHashes, chunk_size: 4 * 1024 * 1024, deleted_flag: false,
		file_id: fileId, owner_timestamp: ts, total_size: plain.length, uploader_hash: UPLOADER,
	};
	const deleted = { ...manifest, chunk_sign_hashes: [], deleted_flag: true, owner_timestamp: ts + 1 };
	const secretB64 = toBase64(secret);
	return {
		fileId, secretB64, plain, bytes, chunkRows,
		manifestRow: { ...manifest, sign_b64: sign(manifest) },
		tombstone: { ...deleted, sign_b64: sign(deleted) },
		part: { kind: 'file', fileId, uploaderHash: UPLOADER, encSecretB64: secretB64, name: 'report.pdf', size: plain.length, mimeType: 'application/pdf', createdAt: ts },
	};
};

/** A row as the shape serves it. */
const onWire = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
	if (k === 'sign_b64') return [k, unpadded(v as string)];
	if (Array.isArray(v)) return [k, v.map((el) => unpadded(el as string))];
	if (typeof v === 'boolean') return [k, v ? 't' : 'f'];
	if (typeof v === 'number') return [k, String(v)];
	return [k, v];
}));

export interface FakeServer {
	files: Map<string, { manifest: Row | null; chunkRows: Row[]; bytes: Array<Uint8Array | null> }>;
	offline: boolean;
	chunkRequests: string[];
	/** The uploader deletes the file: a tombstone manifest, and GC reclaims rows and bytes (pq_files §7–8). */
	deleteFile: (f: PublishedFile) => void;
}

export const installFakeServer = (): FakeServer => {
	const server: FakeServer = {
		files: new Map(),
		offline: false,
		chunkRequests: [],
		deleteFile: (f) => server.files.set(f.fileId, { manifest: f.tombstone, chunkRows: [], bytes: [] }),
	};
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		if (server.offline) throw new TypeError('Failed to fetch');
		const url = decodeURIComponent(typeof input === 'string' ? input : input.toString());
		const shape = (rows: Row[]) => new Response(JSON.stringify(rows.map((value) => ({ value }))), { status: 200 });
		const table = /\/shapes\?table=(\w+)&/.exec(url)?.[1];
		const id = /file_id='([^']+)'/.exec(url)?.[1] ?? /\/file_chunk\/([^/]+)\//.exec(url)?.[1] ?? '';
		const file = server.files.get(id);
		if (table === 'files') return shape(file?.manifest ? [onWire(file.manifest)] : []);
		if (table === 'file_chunks') return shape((file?.chunkRows ?? []).map(onWire));
		const m = url.match(/\/file_chunk\/[^/]+\/(\d+)$/);
		if (m) {
			server.chunkRequests.push(`${id}:${m[1]}`);
			const b = file?.bytes[Number(m[1])];
			return b ? new Response(b, { status: 200 }) : new Response(null, { status: 404 });
		}
		return new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
	return server;
};

export const serve = (server: FakeServer, f: PublishedFile) =>
	server.files.set(f.fileId, { manifest: f.manifestRow, chunkRows: f.chunkRows, bytes: [...f.bytes] });
