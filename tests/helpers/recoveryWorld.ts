// A whole recovery's world, faked where it must be and keeping each party's
// contract (backitup-smart-contracts v2, the relayer, node protocol v3, the
// dialogs): a real backup split, guardians with real stealth slots, a chain
// whose rounds move by its own clock and accept only signatures that recover
// to a guardian, a relayer that checks EIP-712 signatures before it submits,
// nodes that release only while canDecrypt holds for the key that signed the
// request — encrypted to that key — and dialogs that hand a message only to
// its recipient.
import { SigningKey, Wallet, hashMessage, verifyMessage, verifyTypedData } from 'ethers';
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import { computeStealthKey } from 'backitup-secret-recovery-sdk/lib/keys/stealth';
import { defaultSettings } from '@/lib/recovery/backupPlan';
import { prepareRun, shareInputsOf, sharePartOf, type BackupRun } from '@/lib/recovery/backupRun';
import { metaKeysOf, type MetaKeys } from '@/lib/recovery/guardianInvite';
import { domainOf, typesFor } from '@/lib/recovery/typedData';
import { releaseMessage } from '@/lib/recovery/nodeClient';
import { secretIdOf, type Deployment } from '@/lib/recovery/deployments';
import type { ContentPart } from '@/lib/pq/content';
import type { SecretState } from '@/lib/recovery/chain';
import type { Bodies, Dispatch, Gateway } from '@/lib/recovery/gateway';

export const DEPLOYMENT: Deployment = {
	chainId: 11155111,
	rpcUrl: 'https://rpc.invalid',
	secretRecovery: '0xd9FFD20F2DB9c774b9f0237c4837f52DCbD937a7',
	keyRegistry: '0xAD6bD551224003E621d0B4b640C33eF29a5e9828',
	startBlock: 1,
	blockTime: 12,
	relayerUrl: 'https://relay.invalid',
};
export const NAMESPACE = `eip155:${DEPLOYMENT.chainId}:${DEPLOYMENT.secretRecovery.toLowerCase()}`;
export const hashOf = (c: string) => 'u_' + c.repeat(128);

interface Guardian {
	userHash: string;
	keys: MetaKeys;
	/** Their stealth slot of the backup, and the key it derives. */
	stealthAddress: string;
	stealthKey: string;
}

/** ECIES as the SDK encrypts a release (pq_recovery_services § Nodes, "The wire forms of v3"). */
const eciesTo = async (recipientPublicKey: Uint8Array, plaintext: string): Promise<string> => {
	const eph = secp.utils.randomPrivateKey();
	const px = secp.getSharedSecret(eph, recipientPublicKey).slice(1, 33);
	const hash = sha512(px);
	const iv = randomBytes(16);
	const key = await crypto.subtle.importKey('raw', hash.slice(0, 32), { name: 'AES-CBC' }, false, ['encrypt']);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(plaintext)));
	const mac = hmac(sha256, hash.slice(32), concatBytes(iv, secp.getPublicKey(eph, false), ct));
	return bytesToHex(concatBytes(iv, secp.getPublicKey(eph, true), mac, ct));
};

export const makeWorld = () => {
	const clock = { now: 1_800_000_000 };
	const owner = new Wallet('0x' + '77'.repeat(32));
	const nodes = ['a', 'b', 'c'].map((c) => ({ id: 'n_' + c.repeat(32), url: `https://${c}.nodes.example/recovery/node` }));
	const guardianHashes = ['1', '2', '3'].map(hashOf);
	const guardianKeys = [1, 2, 3].map((n) => metaKeysOf(new Uint8Array(32).fill(n)));
	const run: BackupRun = {
		...prepareRun({
			deployment: NAMESPACE,
			owner: owner.address,
			guardians: guardianHashes.map((userHash, i) => ({ userHash, metaAddress: guardianKeys[i].metaAddress })),
			settings: { ...defaultSettings(3, 3), delaySec: 600, windowSec: 3600 },
			nodes,
			device: 'd',
			now: clock.now,
		}),
		version: 1,
	};
	const id = secretIdOf(owner.address, run.label);
	const secretRef = `${NAMESPACE}/${id.toLowerCase()}`;
	const slots = shareInputsOf(run);
	const guardians: Guardian[] = guardianHashes.map((userHash, i) => ({
		userHash,
		keys: guardianKeys[i],
		stealthAddress: slots[i].stealthAddress,
		stealthKey: computeStealthKey({ spendingPrivateKey: guardianKeys[i].spendingPrivateKey, viewingPrivateKey: guardianKeys[i].viewingPrivateKey }, slots[i].ephemeralPubKey),
	}));

	// ------------------------------ the chain ------------------------------
	const s = {
		revoked: false,
		quorum: BigInt(run.settings.approvals),
		delay: BigInt(run.settings.delaySec),
		window: BigInt(run.settings.windowSec),
		round: 0n,
		active: false,
		recipient: '0x' + '00'.repeat(20),
		executeAfter: 0n,
		version: 1n,
	};
	const approvals = new Map<string, Set<string>>();
	const nonces = new Map<string, bigint>();
	const lower = (a: string) => a.toLowerCase();
	const isGuardian = (a: string) => guardians.some((g) => lower(g.stealthAddress) === lower(a));
	const roundState = (): RoundState => {
		if (!s.active) return RoundState.None;
		if (s.executeAfter === 0n) return RoundState.Voting;
		if (BigInt(clock.now) < s.executeAfter) return RoundState.TimeLock;
		if (BigInt(clock.now) < s.executeAfter + s.window) return RoundState.Window;
		return RoundState.Expired;
	};
	const secret = (): SecretState => ({
		owner: owner.address,
		revoked: s.revoked,
		label: run.label,
		threshold: s.quorum,
		recoveryDelay: s.delay,
		recoveryWindow: s.window,
		recoveryRound: s.round,
		recoveryActive: s.active,
		recoveryRecipient: s.recipient,
		executeAfter: s.executeAfter,
		version: s.version,
	});
	const chain = {
		deployment: DEPLOYMENT,
		now: async () => clock.now,
		readSecret: async (sid: string) => (lower(sid) === lower(id) ? secret() : null),
		roundState: async () => roundState(),
		guardiansAt: async () => guardians.map((g) => g.stealthAddress),
		shareAt: async (_sid: string, _v: bigint, a: string) => {
			const slot = slots.find((x) => lower(x.stealthAddress) === lower(a))!;
			return { ephemeralPubKey: slot.ephemeralPubKey, shareEncrypted: slot.shareEncrypted };
		},
		hasApproved: async (_sid: string, candidate: string, g: string) => approvals.get(lower(candidate))?.has(lower(g)) ?? false,
		canDecrypt: async (account: string) => {
			if (s.revoked) return false;
			if (lower(account) === lower(owner.address)) return true;
			return roundState() === RoundState.Window && lower(account) === lower(s.recipient);
		},
		nonce: async (signer: string) => nonces.get(lower(signer)) ?? 0n,
		eip712Domain: async (contract: 'secretRecovery' | 'keyRegistry') => {
			const d = domainOf(DEPLOYMENT, contract);
			return { name: d.name, version: d.version, chainId: BigInt(d.chainId), verifyingContract: d.verifyingContract };
		},
	};

	const canOpen = () => roundState() === RoundState.None || roundState() === RoundState.Expired;
	const initiate = (signer: string) => {
		if (!isGuardian(signer)) throw new Error('NotGuardian');
		if (!canOpen()) throw new Error('RecoveryAlreadyActive');
		s.round += 1n;
		s.active = true;
		s.recipient = '0x' + '00'.repeat(20);
		s.executeAfter = 0n;
		approvals.clear();
	};
	const approve = (signer: string, candidate: string) => {
		if (!isGuardian(signer)) throw new Error('NotGuardian');
		if (roundState() !== RoundState.Voting) throw new Error('QuorumAlreadyReached');
		const set = approvals.get(lower(candidate)) ?? new Set<string>();
		if (set.has(lower(signer))) throw new Error('AlreadyApproved');
		set.add(lower(signer));
		approvals.set(lower(candidate), set);
		if (BigInt(set.size) >= s.quorum) {
			s.recipient = candidate;
			s.executeAfter = BigInt(clock.now) + s.delay;
		}
	};
	const cancel = () => {
		s.active = false;
		s.executeAfter = 0n;
	};

	// ----------------------------- the relayer -----------------------------
	const relayed: { route: string; signer: string }[] = [];
	const checkSigned = async (type: 'InitiateRecovery' | 'ApproveRecovery', b: Bodies['initiateRecovery'] & { candidate?: string }) => {
		const nonce = nonces.get(lower(b.signer)) ?? 0n;
		const message = { id: b.id, version: s.version, round: s.round, nonce, deadline: b.deadline, ...(b.candidate ? { candidate: b.candidate } : {}) };
		const by = verifyTypedData(domainOf(DEPLOYMENT, 'secretRecovery'), typesFor(type), message, b.signature);
		if (lower(by) !== lower(b.signer)) throw new Error('InvalidSignature');
		if (b.deadline < BigInt(clock.now)) throw new Error('SignatureExpired');
		nonces.set(lower(b.signer), nonce + 1n);
	};
	const relayer = {
		initiateRecovery: async (b: Bodies['initiateRecovery']): Promise<Dispatch> => {
			await checkSigned('InitiateRecovery', b);
			initiate(b.signer);
			relayed.push({ route: 'initiate-recovery', signer: lower(b.signer) });
			return { txHash: '0x1', status: 'PROCESSED' };
		},
		approveRecovery: async (b: Bodies['approveRecovery']): Promise<Dispatch> => {
			await checkSigned('ApproveRecovery', b);
			approve(b.signer, b.candidate);
			relayed.push({ route: 'approve-recovery', signer: lower(b.signer) });
			return { txHash: '0x2', status: 'PROCESSED' };
		},
	} as unknown as Gateway;

	// ------------------------------- the nodes -------------------------------
	const nodeCalls: { node: string; recipient: string }[] = [];
	const nodeVersion = new Map<string, number>(nodes.map((n) => [n.id, 1]));
	const nodeFetch = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
		const node = nodes.find((n) => url.startsWith(n.url))!;
		const path = url.slice(node.url.length);
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		if (path === '/health') return json(200, { nodeId: node.id });
		const m = /^\/shares\/(0x[0-9a-f]{64})\/release$/.exec(path);
		if (!m || init?.method !== 'POST') return json(404, { error: 'not found' });
		const body = JSON.parse(String(init.body));
		const text = releaseMessage({ nodeId: node.id, id: m[1], recipient: body.recipient, nonce: body.nonce, ts: body.ts });
		if (lower(verifyMessage(text, body.sig)) !== lower(body.recipient)) return json(401, { error: 'bad signature' });
		nodeCalls.push({ node: node.id, recipient: lower(body.recipient) });
		if (!(await chain.canDecrypt(body.recipient))) return json(403, { error: 'canDecrypt is false' });
		const pub = SigningKey.recoverPublicKey(hashMessage(text), body.sig);
		const share = run.nodeShares[nodes.indexOf(node)]!;
		return json(200, { nodeId: node.id, version: nodeVersion.get(node.id), share_ecies: await eciesTo(hexToBytes(pub.slice(2)), share) });
	}) as typeof fetch;

	// ------------------------------ the dialogs ------------------------------
	let seq = 0;
	const messages: { from: string; to: string; messageId: string; parts: ContentPart[] }[] = [];
	const send = (from: string, to: string, parts: ContentPart[]) => {
		seq += 1;
		const messageId = `dmsg_${String(seq).padStart(8, '0')}`;
		messages.push({ from, to, messageId, parts });
		return messageId;
	};
	const inbox = (me: string, peer: string, kinds: string[]) =>
		messages.filter((m) => m.from === peer && m.to === me).map((m) => ({ messageId: m.messageId, parts: m.parts.filter((p) => kinds.includes(p.kind)) })).filter((m) => m.parts.length);
	const wrote = (me: string) => [...new Set(messages.filter((m) => m.to === me).map((m) => m.from))];

	/** Guardian `i`'s share envelope, as they keep it. */
	const shareOf = (i: number) => {
		const { kind: _kind, ...share } = sharePartOf(run, i, secretRef, clock.now);
		return share;
	};

	return {
		clock,
		run,
		id,
		secretRef,
		nodes,
		guardians,
		chain,
		state: s,
		roundState,
		initiate,
		approve,
		cancel,
		relayer,
		relayed,
		nodeFetch,
		nodeCalls,
		nodeVersion,
		messages,
		send,
		inbox,
		wrote,
		shareOf,
	};
};
export type World = ReturnType<typeof makeWorld>;
