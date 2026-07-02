import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { NETWORK } from './config';
import {
	computeId, splitPayload, generateNodeShares, generateHelperShares,
	recoverNodeHalf, recoverHelperHalf, recoverPayload, generateStealthPrivateKey,
	decryptHelperShare, generateOwnerAccount, createGuardianKeypair,
	generateStealthAddress,
} from './crypto';
import {
	signAddSecret, signRegisterKeys, signInitiateRecovery, signApproveRecovery,
	type ShareInput,
} from './eip712';
import { relayer } from './relayer';
import { depositNodeShare, fetchNodeShare } from './nodes';
import {
	readNonce, readRegistryNonce, readCanDecrypt, readSecret, readSecretOrNull,
	readShare, readStealthMetaAddress, readBalance,
} from './chain';

type LogFn = (msg: string) => void;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const deadlineIn = (s: number) => BigInt(nowSec() + s);

async function waitFor(label: string, check: () => Promise<boolean>, log: LogFn, tries = 60, intervalMs = 3000): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (await check()) {
			log(`✓ ${label}`);
			return;
		}
		if (i === 0) log(`… waiting for ${label}`);
		await sleep(intervalMs);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const nodeList = NETWORK.nodes;

export interface BackupResult {
	id: `0x${string}`;
	K: `0x${string}`;
	backup: NetworkBackupData;
}

export interface NetworkBackupData {
	id: `0x${string}`;
	label: string;
	ownerAddress: `0x${string}`;
	ownerPrivateKey: `0x${string}`;
	K: `0x${string}`;
	friendsHalf: `0x${string}`;
	threshold: number;
	nodeThreshold: number;
	version: number;
	guardians: { eoa: string; label: string; stealthAddress: string; ephemeralPubKey: string }[];
	payload: string;
}

export function saveBackupData(data: NetworkBackupData): void {
	const all = JSON.parse(localStorage.getItem('testbed.backups') ?? '{}');
	all[data.id.toLowerCase()] = data;
	localStorage.setItem('testbed.backups', JSON.stringify(all));
}

export function loadBackupData(id: string): NetworkBackupData | null {
	const all = JSON.parse(localStorage.getItem('testbed.backups') ?? '{}');
	return all[id.toLowerCase()] ?? null;
}

export function listBackupData(): NetworkBackupData[] {
	return Object.values(JSON.parse(localStorage.getItem('testbed.backups') ?? '{}'));
}

export interface GuardianRegInfo {
	label: string;
	eoaAddress: `0x${string}`;
	eoaPrivateKey: `0x${string}`;
	spendingPublicKey: `0x${string}`;
	spendingPrivateKey: `0x${string}`;
	registered: boolean;
}

/** Register a guardian's stealth meta-address on-chain via the relayer. */
export async function registerGuardianOnChain(
	device: { eoaPrivateKey: `0x${string}`; eoaAddress: `0x${string}`; spendingPublicKey: `0x${string}`; label: string },
	log: LogFn,
): Promise<void> {
	const scheme = BigInt(NETWORK.stealthScheme);
	const stealthMetaAddress = device.spendingPublicKey;
	const nonce = await readRegistryNonce(device.eoaAddress);
	const deadline = deadlineIn(3600);
	const sig = await signRegisterKeys(device.eoaPrivateKey, {
		registrant: device.eoaAddress,
		scheme,
		stealthMetaAddress: stealthMetaAddress as `0x${string}`,
		nonce,
		deadline,
	});
	const d = await relayer.registerKeys({
		registrant: device.eoaAddress,
		scheme: String(NETWORK.stealthScheme),
		stealthMetaAddress,
		deadline: deadline.toString(),
		signature: sig,
	});
	log(`[${device.label}] register relayed: ${d.txHash}`);
	await waitFor(
		'registry to reflect meta-address',
		async () => (await readStealthMetaAddress(device.eoaAddress)).toLowerCase() === stealthMetaAddress.toLowerCase(),
		log,
	);
	log(`[${device.label}] registered on-chain ✅`);
}

/** Full backup flow: split, encrypt, sign, relay to contract, deposit to nodes. */
export async function createNetworkBackup(
	owner: { privateKey: `0x${string}`; address: `0x${string}` },
	payload: string,
	label: string,
	guardianDevices: { eoaAddress: `0x${string}`; label: string }[],
	friendThreshold: number,
	log: LogFn,
): Promise<BackupResult> {
	if (guardianDevices.length < 2) throw new Error('Need at least 2 registered guardians');
	if (friendThreshold < 1 || friendThreshold > guardianDevices.length) {
		throw new Error('threshold must be between 1 and guardian count');
	}

	const id = computeId(owner.address, label);
	log(`secret id = ${id}`);

	// Generate random K and XOR split
	const K = generatePrivateKey();
	const bufK = Buffer.from(K.replace('0x', ''), 'hex');
	const bufA = Buffer.alloc(32);
	window.crypto.getRandomValues(bufA);
	const bufB = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) bufB[i] = bufK[i] ^ bufA[i];
	const nodesHalf = ('0x' + bufA.toString('hex')) as `0x${string}`;
	const friendsHalf = ('0x' + bufB.toString('hex')) as `0x${string}`;
	log('split K = nodesHalf XOR friendsHalf');

	// Derive stealth addresses from each guardian's published meta-address
	const stealthResults: { address: `0x${string}`; publicKey: `0x${string}`; ephemeralPubKey: `0x${string}` }[] = [];
	for (const g of guardianDevices) {
		const metaPub = await readStealthMetaAddress(g.eoaAddress);
		if (!metaPub || metaPub === '0x') throw new Error(`guardian ${g.label} not registered in key registry`);
		stealthResults.push(generateStealthAddress(metaPub));
	}
	log(`derived ${stealthResults.length} stealth addresses from registry`);

	// ECIES-encrypt friend shares to each guardian's stealth pubkey
	const friendSharesEnc = await generateHelperShares(
		friendsHalf,
		stealthResults.length,
		friendThreshold,
		stealthResults.map(s => s.publicKey),
	);
	const shares: ShareInput[] = stealthResults.map((s, i) => ({
		stealthAddress: s.address,
		ephemeralPubKey: s.ephemeralPubKey,
		shareEncrypted: friendSharesEnc[i] as `0x${string}`,
	}));

	// Node shares (plain Shamir)
	const nodeCount = NETWORK.nodes.length;
	const nodeThreshold = NETWORK.nodeThreshold;
	if (nodeCount < nodeThreshold) throw new Error('not enough configured nodes');
	const nodeShares = generateNodeShares(nodesHalf, nodeCount, nodeThreshold);

	// Sign EIP-712 AddSecret and send to relayer
	const recoveryDelaySecs = 600n;
	const nonce = await readNonce(owner.address);
	const deadline = deadlineIn(3600);
	const signature = await signAddSecret(owner.privateKey, {
		label,
		shares,
		threshold: BigInt(friendThreshold),
		recoveryDelay: recoveryDelaySecs,
		nonce,
		deadline,
	});
	log('signed AddSecret (EIP-712), relaying…');

	const disp = await relayer.addSecret({
		label,
		shares,
		threshold: friendThreshold,
		recoveryDelay: recoveryDelaySecs.toString(),
		signer: owner.address,
		deadline: deadline.toString(),
		signature,
	});
	log(`relayer tx: ${disp.txHash} (${disp.status})`);

	// Deposit to nodes
	log('depositing node-half shares to test nodes…');
	await Promise.all(
		nodeList.map((n, i) =>
			depositNodeShare(n, { id, version: 1, share: nodeShares[i] }, owner.privateKey)
				.then(() => log(`  → ${n.id} ok`)),
		),
	);

	const guardians = guardianDevices.map((g, i) => ({
		eoa: g.eoaAddress,
		label: g.label,
		stealthAddress: stealthResults[i].address,
		ephemeralPubKey: stealthResults[i].ephemeralPubKey,
	}));

	const backup: NetworkBackupData = {
		id,
		label,
		ownerAddress: owner.address,
		ownerPrivateKey: owner.privateKey,
		K,
		friendsHalf,
		threshold: friendThreshold,
		nodeThreshold,
		version: 1,
		guardians,
		payload,
	};
	saveBackupData(backup);

	await waitFor(
		'secret to appear on-chain',
		async () => {
			const s = await readSecretOrNull(id);
			return !!s && s.owner.toLowerCase() === owner.address.toLowerCase();
		},
		log,
	);
	log('backup complete ✅');
	return { id, K, backup };
}

/** Create a fresh recipient key for recovery. */
export function createRecipientAccount(): { privateKey: `0x${string}`; address: `0x${string}` } {
	return generateOwnerAccount();
}

/** Guardian A: open a recovery round. */
export async function networkInitiateRecovery(
	backupId: `0x${string}`,
	guardianEoa: string,
	guardianEoaPrivateKey: `0x${string}`,
	guardianStealthPrivateKey: `0x${string}`,
	guardianStealthAddress: string,
	log: LogFn,
): Promise<void> {
	const id = backupId;
	const nonce = await readNonce(guardianStealthAddress as `0x${string}`);
	const deadline = deadlineIn(3600);
	const sig = await signInitiateRecovery(guardianStealthPrivateKey as `0x${string}`, { id, nonce, deadline });
	const d = await relayer.initiateRecovery({
		id,
		signer: guardianStealthAddress,
		deadline: deadline.toString(),
		signature: sig,
	});
	log(`initiate relayed: ${d.txHash}`);
	await waitFor('recovery active', async () => (await readSecret(id)).recoveryActive, log);
}

/** Guardian: sign an approval off-chain (returns the approval object). */
export async function networkSignApproval(
	backupId: `0x${string}`,
	guardianStealthPrivateKey: `0x${string}`,
	guardianStealthAddress: string,
	recipient: `0x${string}`,
	label: string,
	log: LogFn,
): Promise<{ candidate: string; signer: string; deadline: string; signature: string; label: string }> {
	const id = backupId;
	const s = await readSecret(id);
	if (!s.recoveryActive) throw new Error('no active recovery; initiate first');
	const nonce = await readNonce(guardianStealthAddress as `0x${string}`);
	const deadline = deadlineIn(3600);
	const signature = await signApproveRecovery(guardianStealthPrivateKey as `0x${string}`, {
		id,
		round: s.recoveryRound,
		candidate: recipient,
		nonce,
		deadline,
	});
	log(`[${label}] signed approval (round ${s.recoveryRound})`);
	return { candidate: recipient, signer: guardianStealthAddress, deadline: deadline.toString(), signature, label };
}

/** Submit all collected approvals in one batch. */
export async function networkSubmitApprovals(
	backupId: `0x${string}`,
	approvals: { candidate: string; signer: string; deadline: string; signature: string; label: string }[],
	log: LogFn,
): Promise<void> {
	const id = backupId;
	if (approvals.length === 0) throw new Error('no signed approvals');
	const d = await relayer.approveRecoveryBatch({
		id,
		approvals: approvals.map(a => ({ candidate: a.candidate, signer: a.signer, deadline: a.deadline, signature: a.signature })),
	});
	log(`batch of ${approvals.length} approvals relayed: ${d.txHash}`);
	await waitFor(
		'quorum (recipient set)',
		async () => (await readSecret(id)).recoveryRecipient.toLowerCase() === approvals[0].candidate.toLowerCase(),
		log,
	);
	const s = await readSecret(id);
	const eta = Number(s.executeAfter) * 1000;
	log(`quorum reached. Time-lock ends: ${new Date(eta).toLocaleTimeString()}`);
}

/** Collect and combine shares after time-lock. */
export async function networkCollectAndCombine(
	backupId: `0x${string}`,
	recipient: `0x${string}`,
	recipientPrivateKey: `0x${string}`,
	log: LogFn,
): Promise<{ recoveredK: string; match: boolean }> {
	const id = backupId;
	const backup = loadBackupData(id);
	if (!backup) throw new Error('no local backup record');

	if (!(await readCanDecrypt(recipient, id))) {
		throw new Error('canDecrypt=false: time-lock not elapsed yet');
	}

	// Decrypt friend shares
	const decFriend: string[] = [];
	for (let i = 0; i < backup.threshold; i++) {
		const ref = backup.guardians[i];
		const device = findGuardianDevice(ref.eoa);
		if (!device) throw new Error(`guardian device for ${ref.label} not found in localStorage`);
		const stealthPriv = generateStealthPrivateKey(device.spendingPrivateKey, ref.ephemeralPubKey);
		const sh = await readShare(id, ref.stealthAddress as `0x${string}`);
		decFriend.push(await decryptHelperShare(sh.shareEncrypted, stealthPriv));
		log(`  ✓ guardian ${ref.label} decrypted their share`);
	}
	const friendsHalf = recoverHelperHalf(decFriend);
	log('recovered friendsHalf from guardian shares');

	// Fetch node shares
	const nodeShares: string[] = [];
	for (const n of nodeList.slice(0, backup.nodeThreshold)) {
		nodeShares.push(await fetchNodeShare(n, id, recipient, recipientPrivateKey));
		log(`  ← ${n.id} released its share`);
	}
	const nodesHalf = recoverNodeHalf(nodeShares);
	log('recovered nodesHalf from node shares');

	// XOR combine
	const bufNodes = Buffer.from(nodesHalf.replace('0x', ''), 'hex');
	const bufFriends = Buffer.from(friendsHalf.replace('0x', ''), 'hex');
	const result = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) result[i] = bufNodes[i] ^ bufFriends[i];
	const recoveredK = '0x' + result.toString('hex');
	const match = recoveredK.toLowerCase() === backup.K.toLowerCase();
	log(match ? 'recovered K matches original ✅' : 'MISMATCH ❌');
	return { recoveredK, match };
}

/** One-click recovery: initiate + threshold approvals + collect. */
export async function networkRunRecovery(backupId: `0x${string}`, log: LogFn): Promise<void> {
	const backup = loadBackupData(backupId);
	if (!backup) throw new Error('no local backup record');

	const recipientPk = generatePrivateKey();
	const recipient = privateKeyToAccount(recipientPk).address;
	log(`recipient (new device) = ${recipient}`);

	// Initiate by first guardian
	const firstRef = backup.guardians[0];
	const firstDevice = findGuardianDevice(firstRef.eoa);
	if (!firstDevice) throw new Error('guardian device not found');
	const firstStealthPriv = generateStealthPrivateKey(firstDevice.spendingPrivateKey, firstRef.ephemeralPubKey);
	await networkInitiateRecovery(
		backupId, firstRef.eoa, firstDevice.eoaPrivateKey, firstStealthPriv, firstRef.stealthAddress, log,
	);

	const s = await readSecret(backupId);
	log(`recovery round = ${s.recoveryRound}`);

	// Sign approvals from first threshold guardians
	const approvals: { candidate: string; signer: string; deadline: string; signature: string; label: string }[] = [];
	for (let i = 0; i < backup.threshold; i++) {
		const ref = backup.guardians[i];
		const device = findGuardianDevice(ref.eoa);
		if (!device) throw new Error(`guardian device for ${ref.label} not found`);
		const stealthPriv = generateStealthPrivateKey(device.spendingPrivateKey, ref.ephemeralPubKey);
		const approval = await networkSignApproval(backupId, stealthPriv, ref.stealthAddress, recipient, ref.label, log);
		approvals.push(approval);
	}
	await networkSubmitApprovals(backupId, approvals, log);

	// Wait for time-lock
	const secret = await readSecret(backupId);
	const waitSec = Number(secret.executeAfter) - nowSec();
	if (waitSec > 0) {
		log(`⏳ Time-lock: ${waitSec}s remaining (testing: relayer skips this on testnet?)`);
	}

	await waitFor('canDecrypt=true', async () => readCanDecrypt(recipient, backupId), log, 1200, 5000);
	await networkCollectAndCombine(backupId, recipient, recipientPk, log);
}

function findGuardianDevice(eoa: string): { spendingPrivateKey: string; stealthAddress: string; eoaPrivateKey: string; ephemeralPubKey: string } | null {
	try {
		const raw = localStorage.getItem('testbed.guardians');
		if (!raw) return null;
		const list = JSON.parse(raw);
		const found = list.find((g: any) => g.eoaAddress.toLowerCase() === eoa.toLowerCase());
		if (!found) return null;
		return {
			spendingPrivateKey: found.spendingPrivateKey,
			stealthAddress: found.stealthAddress,
			eoaPrivateKey: found.eoaPrivateKey,
			ephemeralPubKey: found.ephemeralPubKey,
		};
	} catch {
		return null;
	}
}

export { readBalance };
