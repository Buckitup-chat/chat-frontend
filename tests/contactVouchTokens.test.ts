// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalPayload, fromBase64 } from '@/lib/pq/signature';
import * as harness from './helpers/twoClients';
import { makeTestIdentity, signRow } from './helpers/signedFixtures';
import type { ApplyResult, Client, Relation, Row, ServerPost } from './helpers/twoClients';

const { server, net, register, startApp, signIn, stopAll, newClient } = harness;

vi.mock('@lo-fi/local-vault', async () => (await import('./helpers/twoClients')).vaultModule);
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('vue-router', async () => {
	const { route } = await import('./helpers/twoClients');
	return {
		useRoute: () => ({ params: { get address() { return route.peer; } }, query: {} }),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	};
});
vi.mock('@/components/Account_Item.vue', () => ({ default: { render: () => null } }));
const ScannerEngine = defineComponent({
	emits: ['completed', 'scanning', 'countdown'],
	setup(_, { expose }) {
		expose({ toggleScanner: async () => {}, stopScan: () => {} });
		return () => h('div');
	},
});
vi.mock('@/components/engines/QRScannerEngine.vue', () => ({ default: ScannerEngine }));

const DEVICE_ID = 'Server_test_node';
const READ = `device.${DEVICE_ID}.storage.read`;
const WRITE = `device.${DEVICE_ID}.storage.write`;

type VouchTokenRow = {
	kind: string;
	issuer_hash: string;
	subject_hash: string;
	owner_timestamp: number;
	deleted_flag: boolean;
	sign_b64: string;
};
type VouchKey = Pick<VouchTokenRow, 'kind' | 'issuer_hash' | 'subject_hash'>;
type VouchPost = { type: string; row: VouchTokenRow; result: ApplyResult };
type Mutation = {
	type: string;
	syncMetadata: { relation: string };
	modified?: VouchTokenRow;
	original?: VouchKey;
	changes?: Partial<VouchTokenRow>;
};

const cardOf = (hash: string) => server.table('user_cards').get(hash)!;

const VOUCH_COLUMNS = ['deleted_flag', 'issuer_hash', 'kind', 'owner_timestamp', 'sign_b64', 'subject_hash'];

const VOUCH_SIGNED = ['deleted_flag', 'issuer_hash', 'kind', 'owner_timestamp', 'subject_hash'] as const;
const vouchPayload = (row: Omit<VouchTokenRow, 'sign_b64'>) => {
	const frames = VOUCH_SIGNED.map((field) => new TextEncoder().encode(String(row[field])));
	const out = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
	let at = 0;
	for (const f of frames) {
		new DataView(out.buffer).setUint32(at, f.length);
		out.set(f, at + 4);
		at += 4 + f.length;
	}
	return out;
};
const signedByIssuer = (row: VouchTokenRow) => {
	const card = cardOf(row.issuer_hash);
	try {
		return !!card && ml_dsa87.verify(fromBase64(row.sign_b64), vouchPayload(row), fromBase64(card.sign_pkey as string));
	} catch {
		return false;
	}
};

const vouches = {
	rows: new Map<string, VouchTokenRow>(),
	posts: [] as VouchPost[],
	unavailable: null as ((row: VouchTokenRow) => boolean) | null,
	shapeLag: 0,
	shapeDown: false,
};
const keyOf = (r: VouchKey) => `${r.kind}|${r.issuer_hash}|${r.subject_hash}`;
const vouchOf = (kind: string, issuer: string, subject: string) => vouches.rows.get(keyOf({ kind, issuer_hash: issuer, subject_hash: subject }));
const invalid = (field: string, reason: string): ApplyResult => ({ status: 'error', error: 'validation_failed', details: { [field]: [reason] } });

const applyVouch = (m: Mutation): ApplyResult => {
	let row: VouchTokenRow;
	let result: ApplyResult;
	if (m.type === 'insert') {
		row = m.modified!;
		const stored = vouches.rows.get(keyOf(row));
		result = !signedByIssuer(row) ? invalid('sign_b64', 'invalid signature')
			: stored ? { status: 'exists', conflicted: stored.sign_b64 !== row.sign_b64 }
				: { status: 'ok' };
	} else {
		const stored = vouches.rows.get(keyOf(m.original!));
		const { deleted_flag, owner_timestamp, sign_b64 } = m.changes ?? {};
		row = { ...(stored ?? m.original!), deleted_flag, owner_timestamp, sign_b64 } as VouchTokenRow;
		result = !stored ? invalid('kind', 'not found')
			: !(Number(owner_timestamp) > stored.owner_timestamp) ? invalid('owner_timestamp', 'timestamp not newer')
				: !signedByIssuer(row) ? invalid('sign_b64', 'invalid signature')
					: { status: 'ok' };
	}
	if (result.status === 'ok') vouches.rows.set(keyOf(row), row);
	vouches.posts.push({ type: m.type, row, result });
	return result;
};

const WRITE_GATED: Record<string, string> = {
	user_storage: 'user_hash',
	dialog_keys: 'sender_hash',
	dialog_messages: 'sender_hash',
	dialog_message_reactions: 'reactor_hash',
	dialog_message_receipts: 'peer_hash',
};
let gatedBy: string | null = null;
const NOT_IN_TRUST_CHAIN: ApplyResult = { status: 'error', error: 'not_in_trust_chain' };
const deniedByGate = (m: Mutation) => {
	const field = WRITE_GATED[m.syncMetadata.relation];
	if (!gatedBy || !field) return false;
	const writer = String(((m.modified ?? m.changes ?? m.original) as Record<string, unknown> | undefined)?.[field] ?? '');
	return writer !== gatedBy && !gateAllows(gatedBy, writer, 'write', m.syncMetadata.relation);
};

const ingest = (init?: RequestInit) => {
	const { mutations } = JSON.parse(init!.body as string) as { mutations: Mutation[] };
	const vouchRows = mutations.filter((m) => m.syncMetadata.relation === 'vouch_tokens');
	if (!gatedBy && vouchRows.length === 0) return undefined;
	if (vouchRows.some((m) => vouches.unavailable?.((m.modified ?? { ...m.original, ...m.changes }) as VouchTokenRow))) {
		return new Response('unavailable', { status: 503 });
	}
	const results = mutations.map((m, index) => {
		const relation = m.syncMetadata.relation;
		const row = (m.modified ?? m.changes) as unknown as Row;
		if (relation === 'vouch_tokens') return { index, ...applyVouch(m) };
		if (deniedByGate(m)) {
			(server.posts as ServerPost[]).push({ relation: relation as Relation, row, result: NOT_IN_TRUST_CHAIN });
			return { index, ...NOT_IN_TRUST_CHAIN };
		}
		return { index, ...server.apply(relation as Relation, m.type, row) };
	});
	const failed = results.filter((r) => r.status === 'error');
	const status = failed.length === 0 ? 200 : failed.every((r) => r.error === NOT_IN_TRUST_CHAIN.error) ? 403 : 422;
	return Response.json({ results }, { status });
};

const vouchShape = (url: URL) => {
	if (vouches.shapeDown) return new Response('unavailable', { status: 503 });
	const where = url.searchParams.get('where') ?? '';
	const equals = [...where.matchAll(/(\w+)\s*=\s*'([^']*)'/g)].map(([, col, val]) => [col, val] as const);
	const lagging = vouches.shapeLag > 0;
	if (lagging) vouches.shapeLag--;
	const rows = lagging ? [] : [...vouches.rows.values()].filter((r) =>
		equals.every(([col, val]) => String((r as Record<string, unknown>)[col]) === val));
	return Response.json(rows.map((r) => ({
		headers: { operation: 'insert', relation: ['public', 'vouch_tokens'] },
		key: `"public"."vouch_tokens"/"${r.kind}"/"${r.issuer_hash}"/"${r.subject_hash}"`,
		value: {
			kind: r.kind, issuer_hash: r.issuer_hash, subject_hash: r.subject_hash,
			owner_timestamp: String(r.owner_timestamp), deleted_flag: String(r.deleted_flag),
			sign_b64: r.sign_b64.replace(/=+$/, ''),
		},
	})));
};

type Account = { user_hash: string; sign_pkey: string };
let deviceIdentity: () => Response | Promise<Response>;
let deviceIdentityRequests = 0;
const accountOf = (c: Client): Account => ({ user_hash: c.hash, sign_pkey: cardOf(c.hash).sign_pkey as string });
const identityFor = (admin: Account | null, syncBot?: Account) => () =>
	Response.json({ device_id: DEVICE_ID, admin, sync_bot: syncBot ?? null });
const stranger = (seed: number): Account => {
	const id = makeTestIdentity(seed);
	return { user_hash: id.userHash, sign_pkey: id.signPkeyB64 };
};

const backend = (url: string, init?: RequestInit) => {
	const u = new URL(url, 'http://localhost');
	if (u.pathname.endsWith('/device_identity')) { deviceIdentityRequests++; return deviceIdentity(); }
	if (u.pathname.endsWith('/shapes') && u.searchParams.get('table') === 'vouch_tokens') return vouchShape(u);
	if (u.pathname.endsWith('/ingest_each')) return ingest(init);
	return undefined;
};

const scopeNarrowerOrEq = (a: string, b: string) => {
	const sa = a.split('.');
	const sb = b.split('.');
	return sa.length >= sb.length && sb.every((seg, i) => seg === '*' || sa[i] === seg);
};
const scopeIntersect = (a: string, b: string): string | null => {
	const sa = a.split('.');
	const sb = b.split('.');
	const out: string[] = [];
	for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
		const x = sa[i];
		const y = sb[i];
		if (x === undefined) out.push(y);
		else if (y === undefined) out.push(x);
		else if (x === y) out.push(x);
		else if (x === '*') out.push(y);
		else if (y === '*') out.push(x);
		else return null;
	}
	return out.join('.');
};

let maxDepth = 7;

const gateAllows = (owner: string, subject: string, op: 'read' | 'write', shape = 'user_storage') => {
	if (subject === owner) return true;
	const scope = `device.${DEVICE_ID}.storage.${op}.${shape}`;
	const rows = [...vouches.rows.values()].filter((v) => (v.kind === 'device' || v.kind.startsWith('device.')) && signedByIssuer(v));
	const cancelled = (v: VouchTokenRow) => rows.some((t) => t.deleted_flag && t.issuer_hash === v.issuer_hash && t.subject_hash === v.subject_hash && scopeNarrowerOrEq(v.kind, t.kind));
	type Hop = { user: string; distance: number; effective: string; widened: boolean; path: string[] };
	let frontier: Hop[] = rows
		.filter((v) => v.issuer_hash === owner && !v.deleted_flag && scopeIntersect(scope, v.kind) !== null && !cancelled(v))
		.map((v) => ({ user: v.subject_hash, distance: 1, effective: scopeIntersect(scope, v.kind)!, widened: false, path: [v.subject_hash] }));
	const reached: Hop[] = [...frontier];
	while (frontier.length > 0) {
		const next: Hop[] = [];
		for (const hop of frontier) {
			if (hop.distance >= maxDepth) continue;
			for (const v of rows) {
				if (v.issuer_hash !== hop.user || v.deleted_flag || cancelled(v) || hop.path.includes(v.subject_hash)) continue;
				const effective = scopeIntersect(hop.effective, v.kind);
				if (effective === null) continue;
				next.push({ user: v.subject_hash, distance: hop.distance + 1, effective, widened: hop.widened || !scopeNarrowerOrEq(v.kind, hop.effective), path: [...hop.path, v.subject_hash] });
			}
		}
		reached.push(...next);
		frontier = next;
	}
	const ownerRevoked = rows.some((t) => t.deleted_flag && t.issuer_hash === owner && t.subject_hash === subject && scopeNarrowerOrEq(scope, t.kind));
	return !ownerRevoked && reached.some((h) => h.user === subject && (h.widened
		? scopeNarrowerOrEq(scope, h.effective)
		: scopeNarrowerOrEq(h.effective, scope) || scopeNarrowerOrEq(scope, h.effective)));
};

const settle = (ms = 2_000) => new Promise((resolve) => setTimeout(resolve, ms));

const confirmedOf = (store: Client['app']['store'], peer: Client) =>
	(store.contactsMap as Record<string, { confirmed?: boolean } | undefined>)[peer.hash]?.confirmed;

const confirmByQr = async (peer: Client, shownKey = cardOf(peer.hash).contact_pkey) => {
	const swal = { fire: vi.fn() };
	const Modal = (await import('@/components/modal/views/Modal_QrHandshake.vue')).default;
	const wrapper = mount(Modal, { global: { provide: { $swal: swal, $mitt: { emit: vi.fn() }, $router: { push: vi.fn() } } } });
	await flushPromises();
	wrapper.findComponent(ScannerEngine).vm.$emit('completed', { user_hash: peer.hash, name: peer.name, contact_pkey: shownKey });
	await flushPromises();
	await wrapper.findAll('button').find((b) => /Save contact|Open contact/.test(b.text()))!.trigger('click');
	await vi.waitFor(() => expect(swal.fire).toHaveBeenCalled(), { timeout: 15_000 });
	wrapper.unmount();
	return swal;
};

let Owner: Client;
let Bob: Client;
beforeEach(() => {
	server.reset();
	server.route = backend;
	vouches.rows = new Map();
	vouches.posts = [];
	vouches.unavailable = null;
	vouches.shapeLag = 0;
	vouches.shapeDown = false;
	gatedBy = null;
	maxDepth = 7;
	net.mode = 'online';
	deviceIdentityRequests = 0;
	Owner = newClient('Owner');
	Bob = newClient('Bob');
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: { enumerateDevices: async () => [{ kind: 'videoinput' }] },
	});
});
afterEach(() => stopAll());

describe('the fake backend honours the vouch_tokens contract', () => {
	it('takes a signed insert, applies an update named by its key, refuses a bad signature, and serves rows as Electric does', async () => {
		await register(Owner);
		const issuer = makeTestIdentity(7);
		server.table('user_cards').set(issuer.userHash, issuer.card as never);
		const { sendMutations } = await import('@/lib/data/ingest');
		const { readShapeOnce } = await import('@/lib/data/shapeRead');
		const key = { kind: READ, issuer_hash: issuer.userHash, subject_hash: Owner.hash };
		const grant = signRow(issuer, { ...key, owner_timestamp: 1_700_000_000, deleted_flag: false });
		const revoke = signRow(issuer, { ...key, owner_timestamp: 1_700_000_001, deleted_flag: true }) as VouchTokenRow;
		const update = (row: VouchTokenRow) => ({
			type: 'update', original: key, syncMetadata: { relation: 'vouch_tokens' },
			changes: { deleted_flag: row.deleted_flag, owner_timestamp: row.owner_timestamp, sign_b64: row.sign_b64 },
		});

		await sendMutations([{ type: 'insert', modified: grant, syncMetadata: { relation: 'vouch_tokens' } }], issuer.signSkey);
		await sendMutations([update({ ...revoke, sign_b64: grant.sign_b64 as string })], issuer.signSkey).catch(() => {});
		await sendMutations([update(revoke)], issuer.signSkey);

		expect(vouches.posts.map((p) => [p.type, p.result.status])).toEqual([['insert', 'ok'], ['update', 'error'], ['update', 'ok']]);
		expect(vouchOf(READ, issuer.userHash, Owner.hash)).toEqual(revoke);
		expect(await readShapeOnce('vouch_tokens', `issuer_hash='${issuer.userHash}'`)).toEqual([{
			...key, owner_timestamp: '1700000001', deleted_flag: 'true', sign_b64: revoke.sign_b64.replace(/=+$/, ''),
		}]);
	}, 120_000);
});

describe('the vouch signature payload is the backend\'s', () => {
	const row = {
		kind: 'device.Server_test_node.storage.read',
		issuer_hash: 'u_' + 'a'.repeat(128),
		subject_hash: 'u_' + 'b'.repeat(128),
		owner_timestamp: 1_700_000_000,
		deleted_flag: false,
	};
	const BACKEND_PAYLOAD_HEX =
		'0000000566616c736500000082755f6161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161000000246465766963652e5365727665725f746573745f6e6f64652e73746f726167652e726561640000000a3137303030303030303000000082755f6262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262';

	it('the bytes the fake verifies against, and the client\'s canonicalization of the same row, match the backend', () => {
		expect(bytesToHex(vouchPayload(row))).toBe(BACKEND_PAYLOAD_HEX);
		expect(bytesToHex(canonicalPayload(row))).toBe(BACKEND_PAYLOAD_HEX);
	});
});

describe('FRON-23: the device owner confirms a contact through the QR handshake', () => {
	it('publishes exactly two vouches, read and write, signed by the owner for that contact', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));

		const swal = await confirmByQr(Bob);
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'success', title: 'Contact added and confirmed' }));
		expect(confirmedOf(Owner.app.store, Bob)).toBe(true);

		await vi.waitFor(() => expect(vouches.rows.size).toBe(2), { timeout: 10_000 });
		expect(vouches.posts.map((p) => [p.type, p.result.status])).toEqual([['insert', 'ok'], ['insert', 'ok']]);

		const rows = [...vouches.rows.values()];
		expect(rows.map((r) => r.kind).sort()).toEqual([READ, WRITE]);
		const nowSeconds = Date.now() / 1000;
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(VOUCH_COLUMNS);
			expect(row).toMatchObject({ issuer_hash: Owner.hash, subject_hash: Bob.hash, deleted_flag: false });
			expect(Number.isInteger(row.owner_timestamp)).toBe(true);
			expect(Math.abs(row.owner_timestamp - nowSeconds)).toBeLessThan(300);
			expect(signedByIssuer(row)).toBe(true);
			expect(signedByIssuer({ ...row, subject_hash: Owner.hash })).toBe(false);
		}
	}, 120_000);
});

describe('FRON-23: access follows the vouches, not the local contact flag', () => {
	it('the gate refuses the contact until the vouches are accepted, allows it after, and refuses again after removal', async () => {
		const carol = stranger(9).user_hash;
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		expect(gateAllows(Owner.hash, Bob.hash, 'read') || gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);

		let vouchesFail = true;
		let attempts = 0;
		vouches.unavailable = () => { attempts++; return vouchesFail; };
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		expect(confirmedOf(store, Bob)).toBe(true);
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });
		expect(gateAllows(Owner.hash, Bob.hash, 'read') || gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);

		vouchesFail = false;
		await vi.waitFor(() => {
			expect(gateAllows(Owner.hash, Bob.hash, 'read')).toBe(true);
			expect(gateAllows(Owner.hash, Bob.hash, 'write')).toBe(true);
		}, { timeout: 30_000 });
		expect(gateAllows(Owner.hash, carol, 'read') || gateAllows(Owner.hash, carol, 'write')).toBe(false);

		await store.deleteContact(Bob.hash);
		await vi.waitFor(() => {
			expect(gateAllows(Owner.hash, Bob.hash, 'read')).toBe(false);
			expect(gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);
		}, { timeout: 10_000 });
	}, 120_000);
});

describe('FRON-23: confirming again, removing, and confirming after removal', () => {
	it('does not repeat a live grant, tombstones both rows by update, and re-grants them by update', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		const bobCard = cardOf(Bob.hash) as never;
		const both = () => [READ, WRITE].map((kind) => vouchOf(kind, Owner.hash, Bob.hash));

		await store.confirmContact(Bob.hash, bobCard, { name: 'Bob' });
		await vi.waitFor(() => expect(vouches.rows.size).toBe(2), { timeout: 10_000 });
		const granted = both().map((row) => ({ ...row! }));

		await store.confirmContact(Bob.hash, bobCard, { name: 'Bob' });
		await settle();
		expect(vouches.posts).toHaveLength(2);
		expect(both()).toEqual(granted);

		await store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect(both().map((row) => row?.deleted_flag)).toEqual([true, true]), { timeout: 10_000 });
		const revoked = both().map((row) => ({ ...row! }));
		revoked.forEach((row, i) => expect(row.owner_timestamp).toBeGreaterThan(granted[i].owner_timestamp));

		await store.confirmContact(Bob.hash, bobCard, { name: 'Bob' });
		await vi.waitFor(() => expect(both().map((row) => row?.deleted_flag)).toEqual([false, false]), { timeout: 10_000 });
		both().forEach((row, i) => expect(row!.owner_timestamp).toBeGreaterThan(revoked[i].owner_timestamp));

		expect(vouches.rows.size).toBe(2);
		expect(vouches.posts.map((p) => [p.type, p.result.status])).toEqual([
			['insert', 'ok'], ['insert', 'ok'], ['update', 'ok'], ['update', 'ok'], ['update', 'ok'], ['update', 'ok'],
		]);
	}, 120_000);
});

describe('FRON-23: what the server already holds', () => {
	const grantedThenRevoked = async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(vouches.rows.size).toBe(2), { timeout: 10_000 });
		await store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Bob.hash)?.deleted_flag)).toEqual([true, true]), { timeout: 10_000 });
		return vouches.posts.length;
	};

	it('a stored row whose signature does not verify is not built on', async () => {
		const before = await grantedThenRevoked();
		const read = vouchOf(READ, Owner.hash, Bob.hash)!;
		vouches.rows.set(`${READ}|${Owner.hash}|${Bob.hash}`, { ...read, owner_timestamp: read.owner_timestamp + 1 });

		await Owner.app.store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(vouchOf(WRITE, Owner.hash, Bob.hash)?.deleted_flag).toBe(false), { timeout: 10_000 });
		await settle();
		expect(vouches.posts.slice(before).map((p) => [p.row.kind, p.type, p.result.status])).toEqual([[WRITE, 'update', 'ok']]);
		expect(vouchOf(READ, Owner.hash, Bob.hash)?.deleted_flag).toBe(true);
	}, 120_000);

	it('an insert that meets a row it did not see reads that row and goes on from its state, without inserting again', async () => {
		const before = await grantedThenRevoked();
		vouches.shapeLag = 1;

		await Owner.app.store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Bob.hash)?.deleted_flag)).toEqual([false, false]), { timeout: 15_000 });
		await settle();
		const posts = vouches.posts.slice(before).map((p) => `${p.row.kind === READ ? 'read' : 'write'} ${p.type} ${p.result.status}`);
		expect(posts.filter((p) => p.includes('insert')).sort()).toEqual(['read insert exists', 'write insert exists']);
		expect(posts.filter((p) => p.includes('update')).sort()).toEqual(['read update ok', 'write update ok']);
		expect(posts).toHaveLength(4);
		expect((await Owner.app.outbox.quarantinedEntries(Owner.hash)).filter((e) => e.relation === 'vouch_tokens')).toEqual([]);
	}, 120_000);
});

describe('FRON-23: no owner vouch without a proven owner and device', () => {
	const cases: [name: string, answer: () => Response][] = [
		['admin is another account', () => identityFor(stranger(9), accountOf(Owner))()],
		['admin is null', () => identityFor(null, accountOf(Owner))()],
		['the endpoint is unavailable', () => new Response('unavailable', { status: 503 })],
		['device_id is missing', () => Response.json({ admin: accountOf(Owner) })],
		['device_id is empty', () => Response.json({ device_id: '', admin: accountOf(Owner) })],
		['the body is not JSON', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
	];

	it.each(cases)('%s: the contact is confirmed, no vouch is sent', async (_name, answer) => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = answer;
		const { store } = Owner.app;

		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		expect(confirmedOf(store, Bob)).toBe(true);
		await vi.waitFor(() => expect(deviceIdentityRequests).toBeGreaterThan(0), { timeout: 10_000 });
		await settle();
		expect(vouches.posts).toEqual([]);
	}, 120_000);
});

describe('FRON-23: the account that starts a grant is the one that signs it', () => {
	it('an account switch while the device identity is on its way signs nothing, and leaves nothing behind to send', async () => {
		await register(Bob);
		await register(Owner);
		const owner = accountOf(Owner);
		let answer!: () => void;
		deviceIdentity = () => new Promise<Response>((resolve) => { answer = () => resolve(identityFor(owner)()); });
		const { store } = Owner.app;

		const confirming = store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(deviceIdentityRequests).toBe(1), { timeout: 10_000 });
		await store.logout();
		await store.registerNewUser({ name: 'Second' } as never);
		answer();
		await confirming;

		await settle();
		expect(vouches.posts).toEqual([]);

		const queued = await Owner.app.outbox.pendingEntries(Owner.hash);
		expect(queued.filter((e) => e.relation === 'vouch_tokens')).toEqual([]);
	}, 120_000);
});

describe('FRON-23: contact actions that are not a confirmed handshake', () => {
	it('an unconfirmed QR result, a contact added by id and a first message send no vouch; a confirmed QR then does', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store, $dialogs } = Owner.app;

		const swal = await confirmByQr(Bob, cardOf(Owner.hash).contact_pkey);
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'success', title: 'Contact added' }));
		expect(confirmedOf(store, Bob)).toBeFalsy();

		await store.saveContact(stranger(9).user_hash, { name: 'Added by id', contact_pkey: 'pkC' });

		const statuses: string[] = [];
		await $dialogs.sendMessage(Bob.hash, 'hello', (s: string) => statuses.push(s));
		await vi.waitFor(() => expect(statuses).toContain('synced'), { timeout: 30_000 });

		await settle();
		expect(vouches.posts).toEqual([]);

		await confirmByQr(Bob);
		await vi.waitFor(() => expect(vouches.rows.size).toBe(2), { timeout: 10_000 });
	}, 120_000);
});

describe('FRON-23: failures between the two rows and across sessions', () => {
	it('a write row the server cannot take is retried after a reload, once, without a second read row', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));

		let writeFails = true;
		let writeAttempts = 0;
		vouches.unavailable = (row) => row.kind === WRITE && writeFails && ++writeAttempts > 0;
		await Owner.app.store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(writeAttempts).toBeGreaterThan(0), { timeout: 10_000 });
		expect(vouchOf(WRITE, Owner.hash, Bob.hash)).toBeUndefined();

		await startApp(Owner);
		await signIn(Owner);
		writeFails = false;

		await vi.waitFor(() => expect(vouchOf(WRITE, Owner.hash, Bob.hash)?.deleted_flag).toBe(false), { timeout: 30_000 });
		await settle();
		const accepted = (kind: string) => vouches.posts.filter((p) => p.row.kind === kind && p.result.status === 'ok');
		expect(accepted(READ)).toHaveLength(1);
		expect(accepted(WRITE)).toHaveLength(1);
		expect(vouches.posts.filter((p) => p.result.conflicted === true)).toEqual([]);
		expect(vouches.rows.size).toBe(2);
	}, 120_000);

	it('a grant still pending at logout is not sent while another account is signed in, and is sent when the owner returns', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;

		let vouchesFail = true;
		let attempts = 0;
		vouches.unavailable = () => { attempts++; return vouchesFail; };
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });

		await store.logout();
		await store.registerNewUser({ name: 'Second' } as never);
		expect(store.currentUserHash).not.toBe(Owner.hash);
		const attemptsBeforeSwitch = attempts;
		vouchesFail = false;
		await settle(8_000);
		expect(attempts).toBe(attemptsBeforeSwitch);
		expect(vouches.posts).toEqual([]);

		await store.logout();
		await store.login(Owner.hash);
		await vi.waitFor(() => {
			expect(vouchOf(READ, Owner.hash, Bob.hash)?.deleted_flag).toBe(false);
			expect(vouchOf(WRITE, Owner.hash, Bob.hash)?.deleted_flag).toBe(false);
		}, { timeout: 30_000 });
		expect([...vouches.rows.values()].every((v) => v.issuer_hash === Owner.hash)).toBe(true);
	}, 120_000);
});

describe('FRON-23: the confirmed contact\'s own client', () => {
	it('holds a profile write the gate refuses, and delivers it once the owner has confirmed the contact', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		gatedBy = Owner.hash;

		await startApp(Bob);
		await signIn(Bob);
		const bobWrites = () => server.posts.filter((p) => p.relation === 'user_storage' && (p.row as { user_hash?: string }).user_hash === Bob.hash);
		const sinceGate = bobWrites().length;
		const saved = await Bob.app.store.updateCurrentUserProfile({ name: 'Bob, renamed', notes: undefined, avatarUuid: undefined, avatarDataUrl: undefined });
		expect(saved).toMatchObject({ awaitingApproval: true });
		expect(bobWrites().slice(sinceGate).map((p) => p.result.error)).toContain('not_in_trust_chain');
		expect(bobWrites().slice(sinceGate).some((p) => p.result.status === 'ok')).toBe(false);

		await startApp(Owner);
		await signIn(Owner);
		await Owner.app.store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(vouches.rows.size, 'the owner\'s client published the grants').toBe(2), { timeout: 10_000 });

		const beforeBobReturns = bobWrites().length;
		await startApp(Bob);
		await signIn(Bob);
		await vi.waitFor(() => expect(bobWrites().slice(beforeBobReturns).some((p) => p.result.status === 'ok')).toBe(true), { timeout: 30_000 });
		expect(bobWrites().slice(beforeBobReturns).filter((p) => p.result.status === 'error')).toEqual([]);
	}, 120_000);
});

describe('FRON-23: a revoke the server has not seen yet', () => {
	const liveGrants = () => [READ, WRITE].filter((kind) => vouchOf(kind, Owner.hash, Bob.hash)?.deleted_flag === false);
	const pendingVouchWrites = async () => (await Owner.app.outbox.pendingEntries(Owner.hash)).filter((e) => e.relation === 'vouch_tokens');
	const requestLog = () => vouches.posts.map((p) => `${p.row.kind === READ ? 'read' : 'write'} ${p.type} deleted_flag=${p.row.deleted_flag} ${p.result.status}`);

	it('a contact deleted while its grants wait in the outbox ends with no access, across a reload', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;

		let down = true;
		let attempts = 0;
		vouches.unavailable = () => { attempts++; return down; };
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });
		await store.deleteContact(Bob.hash);

		await startApp(Owner);
		await signIn(Owner);
		down = false;

		await vi.waitFor(async () => {
			expect(await pendingVouchWrites()).toEqual([]);
			expect(liveGrants()).toEqual([]);
		}, { timeout: 45_000 });
		await settle();
		console.warn('[FRON-23 request log, delete while pending]', JSON.stringify(requestLog()));
		expect(liveGrants()).toEqual([]);
		expect(gateAllows(Owner.hash, Bob.hash, 'read') || gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);
	}, 120_000);

	it('read granted on the server, write still queued: the delete revokes each scope above its own last grant', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;

		let writeDown = true;
		let writeAttempts = 0;
		vouches.unavailable = (row) => row.kind === WRITE && writeDown && ++writeAttempts > 0;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => {
			expect(liveGrants()).toEqual([READ]);
			expect(writeAttempts).toBeGreaterThan(0);
		}, { timeout: 10_000 });
		await store.deleteContact(Bob.hash);

		await startApp(Owner);
		await signIn(Owner);
		writeDown = false;

		await vi.waitFor(async () => {
			expect(await pendingVouchWrites()).toEqual([]);
			expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Bob.hash)?.deleted_flag)).toEqual([true, true]);
		}, { timeout: 45_000 });
		await settle();
		console.warn('[FRON-23 request log, read granted, write queued]', JSON.stringify(requestLog()));
		for (const kind of [READ, WRITE]) {
			const accepted = vouches.posts.filter((p) => p.row.kind === kind && p.result.status === 'ok');
			const last = accepted[accepted.length - 1];
			expect(last.row.deleted_flag).toBe(true);
			expect(accepted.every((p) => p === last || p.row.owner_timestamp < last.row.owner_timestamp)).toBe(true);
		}
		expect(gateAllows(Owner.hash, Bob.hash, 'read') || gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);
	}, 120_000);

	it('a revoke that could not read the server\'s rows is finished after a reload, and both grants end as tombstones', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(liveGrants()).toEqual([READ, WRITE]), { timeout: 10_000 });

		vouches.shapeDown = true;
		await store.deleteContact(Bob.hash);
		expect((store.contactsMap as Record<string, unknown>)[Bob.hash]).toBeUndefined();
		expect(liveGrants()).toEqual([READ, WRITE]);

		await startApp(Owner);
		await signIn(Owner);
		vouches.shapeDown = false;

		await vi.waitFor(() => expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Bob.hash)?.deleted_flag)).toEqual([true, true]), { timeout: 45_000 });
		console.warn('[FRON-23 request log, revoke after shapes return]', JSON.stringify(requestLog()));
		expect(gateAllows(Owner.hash, Bob.hash, 'read') || gateAllows(Owner.hash, Bob.hash, 'write')).toBe(false);
	}, 120_000);
});

describe('FRON-23: a scope that cannot be finished now is not reported finished', () => {
	const stateOf = () => [READ, WRITE].map((k) => vouchOf(k, Owner.hash, Bob.hash)?.deleted_flag);
	const requestLog = (from = 0) => vouches.posts.slice(from).map((p) => `${p.row.kind === READ ? 'read' : 'write'} ${p.type} deleted_flag=${p.row.deleted_flag} ${p.result.status}`);
	const openAccessIntents = async () => {
		const { intentsOf } = await import('@/lib/data/intents');
		const { entries } = await intentsOf(Owner.hash);
		return entries.filter((e) => (e.intent as { kind?: string }).kind === 'contact-access')
			.map((e) => e.intent as { subjectHash: string; granted: boolean });
	};
	const vouchEntries = async () => {
		const { outbox } = Owner.app;
		return [...await outbox.pendingEntries(Owner.hash), ...await outbox.quarantinedEntries(Owner.hash)]
			.filter((e) => e.relation === 'vouch_tokens').map((e) => e.status);
	};

	it('a revoke that meets an unverifiable row keeps that scope open across a reload, and finishes it once the row verifies', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(stateOf()).toEqual([false, false]), { timeout: 10_000 });

		const genuine = vouchOf(READ, Owner.hash, Bob.hash)!;
		const key = `${READ}|${Owner.hash}|${Bob.hash}`;
		vouches.rows.set(key, { ...genuine, owner_timestamp: genuine.owner_timestamp + 1 });
		await store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect(vouchOf(WRITE, Owner.hash, Bob.hash)?.deleted_flag).toBe(true), { timeout: 10_000 });

		await startApp(Owner);
		await signIn(Owner);
		await settle();
		console.warn('[FRON-23 after reload, unverifiable read row]', JSON.stringify({ intents: await openAccessIntents(), outbox: await vouchEntries(), vouches: stateOf() }));
		expect(await openAccessIntents()).toEqual([expect.objectContaining({ kind: 'contact-access', subjectHash: Bob.hash, granted: false })]);
		expect(stateOf()).toEqual([false, true]);

		vouches.rows.set(key, genuine);
		await vi.waitFor(() => expect(stateOf()).toEqual([true, true]), { timeout: 45_000 });
		await vi.waitFor(async () => expect(await openAccessIntents()).toEqual([]), { timeout: 10_000 });
		console.warn('[FRON-23 request log, unverifiable read row]', JSON.stringify(requestLog()));
	}, 120_000);

	it('an insert the background sender finds already on the server is followed through from that row, not inserted again', async () => {
		await register(Bob);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		const { store } = Owner.app;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(stateOf()).toEqual([false, false]), { timeout: 10_000 });
		await store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect(stateOf()).toEqual([true, true]), { timeout: 10_000 });
		const before = vouches.posts.length;

		let down = true;
		let attempts = 0;
		vouches.unavailable = () => { attempts++; return down; };
		vouches.shapeLag = 1;
		await store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });

		await startApp(Owner);
		await signIn(Owner);
		console.warn('[FRON-23 after reload, background conflict]', JSON.stringify({ intents: await openAccessIntents(), outbox: await vouchEntries(), vouches: stateOf() }));
		down = false;

		await vi.waitFor(() => expect(stateOf()).toEqual([false, false]), { timeout: 45_000 });
		await settle();
		const log = requestLog(before);
		console.warn('[FRON-23 request log, background conflict]', JSON.stringify(log));
		expect(log.filter((l) => l.includes(' insert ')).sort()).toEqual(['read insert deleted_flag=false exists', 'write insert deleted_flag=false exists']);
		expect(log.filter((l) => l.includes(' update ')).sort()).toEqual(['read update deleted_flag=false ok', 'write update deleted_flag=false ok']);
		expect(await vouchEntries()).toEqual([]);
		expect(await openAccessIntents()).toEqual([]);
	}, 120_000);
});

describe('transitive access: the owner vouches for A, A confirms B in person', () => {
	let Ann: Client;
	beforeEach(() => { Ann = newClient('Ann'); });

	const switchTo = async (client: Client) => { await startApp(client); await signIn(client); };
	const rowsAbout = (subject: Client) => [...vouches.rows.values()].filter((v) => v.subject_hash === subject.hash);
	const access = (owner: string, subject: Client) => ({ read: gateAllows(owner, subject.hash, 'read'), write: gateAllows(owner, subject.hash, 'write') });
	const fixtureOwner = (seed: number) => {
		const id = makeTestIdentity(seed);
		server.table('user_cards').set(id.userHash, id.card as never);
		const vouch = (subject: Client, scopes: ('read' | 'write')[]) => {
			for (const scope of scopes) {
				const row = signRow(id, { kind: `device.${DEVICE_ID}.storage.${scope}`, issuer_hash: id.userHash, subject_hash: subject.hash, owner_timestamp: 1_700_000_000, deleted_flag: false }) as VouchTokenRow;
				vouches.rows.set(keyOf(row), row);
			}
		};
		return { hash: id.userHash, account: { user_hash: id.userHash, sign_pkey: id.signPkeyB64 }, vouch };
	};
	const annConfirmsBob = async () => {
		await Ann.app.store.confirmContact(Bob.hash, cardOf(Bob.hash) as never, { name: 'Bob' });
	};
	const annVouchesBob = () => [READ, WRITE].map((k) => vouchOf(k, Ann.hash, Bob.hash)?.deleted_flag);

	it('B reaches the device through owner → A → B, with A as the issuer of the second hop, within the allowed depth', async () => {
		await register(Bob);
		await register(Ann);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		await Owner.app.store.confirmContact(Ann.hash, cardOf(Ann.hash) as never, { name: 'Ann' });
		await vi.waitFor(() => expect(access(Owner.hash, Ann)).toEqual({ read: true, write: true }), { timeout: 10_000 });

		await switchTo(Ann);
		await annConfirmsBob();
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([false, false]), { timeout: 10_000 });
		for (const row of rowsAbout(Bob)) {
			expect(row.issuer_hash).toBe(Ann.hash);
			expect(signedByIssuer(row)).toBe(true);
		}
		expect(access(Owner.hash, Bob)).toEqual({ read: true, write: true });
		maxDepth = 1;
		expect(access(Owner.hash, Bob)).toEqual({ read: false, write: false });
	}, 120_000);

	it('A holding only read: A\'s signed write vouch gives B no write', async () => {
		await register(Bob);
		await register(Ann);
		const device = fixtureOwner(21);
		deviceIdentity = identityFor(device.account);
		device.vouch(Ann, ['read']);

		await annConfirmsBob();
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([false, false]), { timeout: 10_000 });
		expect(access(device.hash, Ann)).toEqual({ read: true, write: false });
		expect(access(device.hash, Bob)).toEqual({ read: true, write: false });
	}, 120_000);

	it('without a live path from the owner to A, A\'s vouch gives B nothing', async () => {
		await register(Bob);
		await register(Ann);
		const device = fixtureOwner(21);
		const stranger = fixtureOwner(22);
		deviceIdentity = identityFor(device.account);
		stranger.vouch(Ann, ['read', 'write']);

		await annConfirmsBob();
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([false, false]), { timeout: 10_000 });
		expect(access(device.hash, Ann)).toEqual({ read: false, write: false });
		expect(access(device.hash, Bob)).toEqual({ read: false, write: false });
	}, 120_000);

	it('A deleting B revokes exactly A → B; the owner revoking A cuts B off as well', async () => {
		await register(Bob);
		await register(Ann);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		await Owner.app.store.confirmContact(Ann.hash, cardOf(Ann.hash) as never, { name: 'Ann' });
		await vi.waitFor(() => expect(access(Owner.hash, Ann)).toEqual({ read: true, write: true }), { timeout: 10_000 });

		await switchTo(Ann);
		await annConfirmsBob();
		await vi.waitFor(() => expect(access(Owner.hash, Bob)).toEqual({ read: true, write: true }), { timeout: 10_000 });
		await Ann.app.store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([true, true]), { timeout: 10_000 });
		expect(access(Owner.hash, Bob)).toEqual({ read: false, write: false });
		expect(access(Owner.hash, Ann)).toEqual({ read: true, write: true });
		expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Ann.hash)?.deleted_flag)).toEqual([false, false]);

		await annConfirmsBob();
		await vi.waitFor(() => expect(access(Owner.hash, Bob)).toEqual({ read: true, write: true }), { timeout: 10_000 });

		await switchTo(Owner);
		await Owner.app.store.deleteContact(Ann.hash);
		await vi.waitFor(() => expect([READ, WRITE].map((k) => vouchOf(k, Owner.hash, Ann.hash)?.deleted_flag)).toEqual([true, true]), { timeout: 10_000 });
		expect(access(Owner.hash, Ann)).toEqual({ read: false, write: false });
		expect(access(Owner.hash, Bob)).toEqual({ read: false, write: false });
		expect(annVouchesBob()).toEqual([false, false]);
	}, 120_000);

	it('queued grants and revokes of A keep A as the issuer and their order, across reloads and other accounts\' sessions', async () => {
		await register(Bob);
		await register(Ann);
		await register(Owner);
		deviceIdentity = identityFor(accountOf(Owner));
		await Owner.app.store.confirmContact(Ann.hash, cardOf(Ann.hash) as never, { name: 'Ann' });
		await vi.waitFor(() => expect(access(Owner.hash, Ann)).toEqual({ read: true, write: true }), { timeout: 10_000 });

		await switchTo(Ann);
		let down = true;
		let attempts = 0;
		vouches.unavailable = () => { attempts++; return down; };
		await annConfirmsBob();
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });
		await switchTo(Ann);
		down = false;
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([false, false]), { timeout: 45_000 });

		const afterGrant = vouches.posts.length;
		await annConfirmsBob();
		await settle();
		expect(vouches.posts.slice(afterGrant)).toEqual([]);

		down = true;
		attempts = 0;
		await Ann.app.store.deleteContact(Bob.hash);
		await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 10_000 });
		await switchTo(Owner);
		down = false;
		await settle(8_000);
		expect(annVouchesBob()).toEqual([false, false]);
		await switchTo(Ann);
		await vi.waitFor(() => expect(annVouchesBob()).toEqual([true, true]), { timeout: 45_000 });

		const aboutBob = vouches.posts.filter((p) => p.row.subject_hash === Bob.hash);
		expect(aboutBob.every((p) => p.row.issuer_hash === Ann.hash)).toBe(true);
		for (const kind of [READ, WRITE]) {
			const accepted = aboutBob.filter((p) => p.row.kind === kind && p.result.status === 'ok');
			console.warn(`[transitive request log, ${kind === READ ? 'read' : 'write'}]`, JSON.stringify(accepted.map((p) => `${p.type} deleted_flag=${p.row.deleted_flag} ts=${p.row.owner_timestamp}`)));
			expect(accepted.map((p) => p.row.deleted_flag)).toEqual([false, true]);
			expect(accepted[1].row.owner_timestamp).toBeGreaterThan(accepted[0].row.owner_timestamp);
		}
		expect(access(Owner.hash, Bob)).toEqual({ read: false, write: false });
	}, 150_000);
});

describe('transitive access from an account whose own writes still wait for approval', () => {
	let Ann: Client;
	beforeEach(() => { Ann = newClient('Ann'); });

	it('A, holding read only, confirms B through the QR modal: the contact waits on the device, A → B goes out at once, and the contact syncs once A may write', async () => {
		const { cardVouchesForContactKey } = await import('@/lib/pq/verifyCard');
		await register(Bob);
		await register(Ann);
		const owner = makeTestIdentity(21);
		server.table('user_cards').set(owner.userHash, owner.card as never);
		deviceIdentity = identityFor({ user_hash: owner.userHash, sign_pkey: owner.signPkeyB64 });
		const ownerVouches = (scope: 'read' | 'write') => {
			const row = signRow(owner, { kind: `device.${DEVICE_ID}.storage.${scope}`, issuer_hash: owner.userHash, subject_hash: Ann.hash, owner_timestamp: 1_700_000_000, deleted_flag: false }) as VouchTokenRow;
			vouches.rows.set(keyOf(row), row);
		};
		ownerVouches('read');
		gatedBy = owner.userHash;
		const sinceGate = server.posts.length;
		const annStorageWrites = () => server.posts.slice(sinceGate).filter((p) => p.relation === 'user_storage' && (p.row as { user_hash?: string }).user_hash === Ann.hash);
		const annToBob = () => vouches.posts.filter((p) => p.row.issuer_hash === Ann.hash && p.row.subject_hash === Bob.hash);
		const contacts = () => Ann.app.store.contactsMap as Record<string, { confirmed?: boolean } | undefined>;

		expect(cardVouchesForContactKey(cardOf(Bob.hash) as never, Bob.hash, cardOf(Ann.hash).contact_pkey as string)).toBe(false);
		await confirmByQr(Bob, cardOf(Ann.hash).contact_pkey);
		expect(contacts()[Bob.hash]?.confirmed).toBeFalsy();

		expect(cardVouchesForContactKey(cardOf(Bob.hash) as never, Bob.hash, cardOf(Bob.hash).contact_pkey as string)).toBe(true);
		const swal = await confirmByQr(Bob);
		expect(swal.fire).not.toHaveBeenCalledWith(expect.objectContaining({ icon: 'error' }));
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Contact confirmed on this device' }));
		expect(contacts()[Bob.hash]?.confirmed).toBe(true);
		await vi.waitFor(() => expect([READ, WRITE].map((k) => vouchOf(k, Ann.hash, Bob.hash)?.deleted_flag)).toEqual([false, false]), { timeout: 10_000 });
		expect(annStorageWrites().map((p) => p.result.error)).toContain('not_in_trust_chain');
		expect(annStorageWrites().some((p) => p.result.status === 'ok')).toBe(false);
		expect(gateAllows(owner.userHash, Bob.hash, 'read')).toBe(true);
		expect(gateAllows(owner.userHash, Bob.hash, 'write')).toBe(false);

		const Cora = stranger(23).user_hash;
		await Ann.app.store.saveContact(Cora, { name: 'Cora', contact_pkey: 'pkC' }).catch(() => {});
		await settle();
		expect(vouches.posts.filter((p) => p.row.subject_hash === Cora)).toEqual([]);

		await startApp(Ann);
		await signIn(Ann);
		await vi.waitFor(() => expect(contacts()[Bob.hash]?.confirmed).toBe(true), { timeout: 10_000 });
		await settle();
		expect(annToBob().map((p) => p.type)).toEqual(['insert', 'insert']);

		ownerVouches('write');
		await startApp(Ann);
		await signIn(Ann);
		await vi.waitFor(() => expect(annStorageWrites().some((p) => p.result.status === 'ok')).toBe(true), { timeout: 45_000 });
		await vi.waitFor(async () => {
			const { pendingEntries } = Ann.app.outbox;
			expect((await pendingEntries(Ann.hash)).filter((e) => e.relation === 'user_storage')).toEqual([]);
		}, { timeout: 45_000 });
		await startApp(Ann);
		await signIn(Ann);
		await vi.waitFor(() => expect(contacts()[Bob.hash]?.confirmed).toBe(true), { timeout: 10_000 });
		console.warn('[approval-held contact, A contacts after sync]', JSON.stringify(Object.values(contacts()).map((c) => ({ name: (c as { name?: string }).name, confirmed: !!c?.confirmed }))));
		console.warn('[approval-held contact, A storage writes]', JSON.stringify(annStorageWrites().map((p) => `${p.result.status}:${p.result.error ?? ''}`)));
		console.warn('[approval-held contact, A → B vouches]', JSON.stringify(annToBob().map((p) => `${p.row.kind === READ ? 'read' : 'write'} ${p.type} ${p.result.status}`)));
		expect(annToBob().map((p) => p.type)).toEqual(['insert', 'insert']);
		expect(gateAllows(owner.userHash, Ann.hash, 'write')).toBe(true);
		expect(gateAllows(owner.userHash, Bob.hash, 'read')).toBe(true);
		expect(gateAllows(owner.userHash, Bob.hash, 'write')).toBe(true);
	}, 200_000);
});

describe('contact changes from an account whose own writes still wait for approval', () => {
	let Ann: Client;
	beforeEach(() => { Ann = newClient('Ann'); });

	const readOnlyAnn = async () => {
		await register(Bob);
		await register(Ann);
		const owner = makeTestIdentity(21);
		server.table('user_cards').set(owner.userHash, owner.card as never);
		deviceIdentity = identityFor({ user_hash: owner.userHash, sign_pkey: owner.signPkeyB64 });
		const ownerVouches = (scope: 'read' | 'write') => {
			const row = signRow(owner, { kind: `device.${DEVICE_ID}.storage.${scope}`, issuer_hash: owner.userHash, subject_hash: Ann.hash, owner_timestamp: 1_700_000_000, deleted_flag: false }) as VouchTokenRow;
			vouches.rows.set(keyOf(row), row);
		};
		ownerVouches('read');
		gatedBy = owner.userHash;
		const sinceGate = server.posts.length;
		return {
			owner: owner.userHash,
			grantWrite: () => ownerVouches('write'),
			storageWrites: () => server.posts.slice(sinceGate).filter((p) => p.relation === 'user_storage' && (p.row as { user_hash?: string }).user_hash === Ann.hash),
		};
	};
	const contacts = () => Ann.app.store.contactsMap as Record<string, { confirmed?: boolean } | undefined>;
	const annToBob = () => [READ, WRITE].map((k) => vouchOf(k, Ann.hash, Bob.hash)?.deleted_flag);
	const switchTo = async (client: Client) => { await startApp(client); await signIn(client); };
	const heldStorageWrites = async () => (await Ann.app.outbox.pendingEntries(Ann.hash)).filter((e) => e.relation === 'user_storage');

	it('A deletes B while A\'s writes wait: A → B is revoked at once, the deletion stays on the device, and syncs once A may write', async () => {
		const device = await readOnlyAnn();
		await confirmByQr(Bob);
		await vi.waitFor(() => expect(annToBob()).toEqual([false, false]), { timeout: 10_000 });
		expect(gateAllows(device.owner, Bob.hash, 'read')).toBe(true);

		await Ann.app.store.deleteContact(Bob.hash).catch((e: unknown) => console.warn('[delete while held] deleteContact threw:', String(e)));
		await vi.waitFor(() => expect(annToBob()).toEqual([true, true]), { timeout: 15_000 });
		expect(gateAllows(device.owner, Bob.hash, 'read')).toBe(false);
		expect(contacts()[Bob.hash]).toBeUndefined();
		expect(device.storageWrites().some((p) => p.result.status === 'ok')).toBe(false);
		console.warn('[delete while held, before reload]', JSON.stringify({ contact: contacts()[Bob.hash] ?? null, vouches: annToBob(), held: (await heldStorageWrites()).length }));

		await switchTo(Ann);
		await settle();
		expect(contacts()[Bob.hash]).toBeUndefined();
		console.warn('[delete while held, after reload]', JSON.stringify({ contact: contacts()[Bob.hash] ?? null, vouches: annToBob(), held: (await heldStorageWrites()).length }));

		device.grantWrite();
		await switchTo(Ann);
		await vi.waitFor(async () => expect(await heldStorageWrites()).toEqual([]), { timeout: 45_000 });
		await switchTo(Ann);
		await settle();
		expect(contacts()[Bob.hash]).toBeUndefined();
		const log = vouches.posts.filter((p) => p.row.issuer_hash === Ann.hash && p.row.subject_hash === Bob.hash)
			.map((p) => `${p.row.kind === READ ? 'read' : 'write'} ${p.type} deleted_flag=${p.row.deleted_flag} ${p.result.status}`);
		console.warn('[delete while held, A → B requests]', JSON.stringify(log));
		expect(log.filter((l) => l.includes('update')).sort()).toEqual(['read update deleted_flag=true ok', 'write update deleted_flag=true ok']);
		expect(log).toHaveLength(4);
		expect(annToBob()).toEqual([true, true]);
	}, 200_000);

	it('a contact added by id while A\'s writes wait is kept on the device and said to be, and reaches the server later without a vouch', async () => {
		const device = await readOnlyAnn();
		const swal = { fire: vi.fn() };
		const Modal = (await import('@/components/modal/views/Modal_QrHandshake.vue')).default;
		const wrapper = mount(Modal, { global: { provide: { $swal: swal, $mitt: { emit: vi.fn() }, $router: { push: vi.fn() } } } });
		await flushPromises();
		await wrapper.findAll('button').find((b) => b.text().includes('Add manually'))!.trigger('click');
		await wrapper.find('input').setValue(Bob.hash);
		await wrapper.findAll('button').find((b) => b.text() === 'Add')!.trigger('click');
		await vi.waitFor(() => expect(swal.fire).toHaveBeenCalled(), { timeout: 15_000 });
		wrapper.unmount();

		expect(swal.fire).not.toHaveBeenCalledWith(expect.objectContaining({ icon: 'error' }));
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Contact added on this device' }));
		expect(contacts()[Bob.hash]).toBeDefined();
		expect(contacts()[Bob.hash]?.confirmed).toBeFalsy();

		await switchTo(Ann);
		await vi.waitFor(() => expect(contacts()[Bob.hash]).toBeDefined(), { timeout: 10_000 });

		device.grantWrite();
		await switchTo(Ann);
		await vi.waitFor(async () => expect(await heldStorageWrites()).toEqual([]), { timeout: 45_000 });
		expect(device.storageWrites().some((p) => p.result.status === 'ok')).toBe(true);
		await switchTo(Ann);
		await vi.waitFor(() => expect(contacts()[Bob.hash]).toBeDefined(), { timeout: 10_000 });
		expect(vouches.posts.filter((p) => p.row.subject_hash === Bob.hash)).toEqual([]);
	}, 200_000);
});
