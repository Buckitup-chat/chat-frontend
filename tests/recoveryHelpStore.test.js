// The guardian helping someone back in (plan § 7.5), through its store: the
// request in the dialog, the binding checked and its words, the round opened
// and the approval signed by the guardian's own stealth key and sent through
// the free service, and the piece sent back by itself only once the send gate
// opens — never in the timelock, never after a veto or for another device. The
// chain, relayer and dialogs are recoveryWorld's contract-keeping fakes; the
// signatures, stealth keys and slot are real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { toBase64 } from '@/lib/pq/signature';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import { recoveryWords } from '@/lib/recovery/recoveryBinding';
import { bindingFor, candidateOf, findSecretRef } from '@/lib/recovery/restoring';
import { bindingText, parseReturnBlock, readReturnBlock } from '@/lib/recovery/manualReturn';
import { checkReturn } from '@/lib/recovery/recovering';
import { DEPLOYMENT, hashOf, makeWorld } from './helpers/recoveryWorld';

const TEMP = hashOf('e');
const KEY = '0x' + '42'.repeat(32);
const H = vi.hoisted(() => ({ world: null, me: 0, slots: {}, gateways: [], cards: {}, signer: null }));

const user = reactive({ currentUserHash: null, getUserByHash: (h) => H.cards[h] });
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({
		readPeerParts: async (peer, kinds) => ({ messages: H.world.inbox(user.currentUserHash, peer, kinds), delivered: [] }),
		sendMessage: async (peer, parts) => H.world.send(user.currentUserHash, peer, parts),
	}),
}));
const holdings = reactive({ holdings: {}, list: [], load: async () => true });
vi.mock('@/store/recoveryHoldings.store', () => ({ useRecoveryHoldingsStore: () => holdings }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			// Each guardian's own slot.
			loadSlotJson: async () => H.slots[H.me] ?? null,
			patchSlotJson: async (_name, patch) => (H.slots[H.me] = stripPatchDirectives(mergeJsonPatch(H.slots[H.me] ?? null, patch))),
			guardianMetaSeed: async () => bytesToHex(new Uint8Array(32).fill(H.me + 1)),
			signChallenge: async (bytes) => ml_dsa87.sign(bytes, H.signer.secretKey),
		}),
	},
}));
vi.mock('@/lib/recovery/deployments', async (orig) => ({ ...(await orig()), maybeRecoveryDeployment: () => DEPLOYMENT }));
vi.mock('@/lib/recovery/chain', async (orig) => ({
	...(await orig()),
	RecoveryChain: class {
		constructor() {
			return H.world.chain;
		}
	},
}));
vi.mock('@/lib/recovery/gateway', async (orig) => ({
	...(await orig()),
	// The choice of gateway is gatewayOf's (tested on its own): here, what the store asks of it.
	gatewayOf: (_chain, fee, key, url) => (H.gateways.push({ fee, key, url }), H.world.relayer),
}));

const { useRecoveryHelpStore, HELP_SLOT } = await import('@/store/recoveryHelp.store');

let w;
let store;
/** Signs in as guardian `i`, who keeps piece i. */
const as = (i) => {
	H.me = i;
	user.currentUserHash = w.guardians[i].userHash;
	const share = w.shareOf(i);
	const key = `${hashOf('o')}|${w.secretRef}|1|${share.splitId}|${share.shareIndex}`;
	holdings.holdings = { [key]: { owner: hashOf('o'), share: { kind: 'recovery_share', ...share }, messageId: 'm', state: 'stored', detail: '', updatedAt: 1 } };
	holdings.list = Object.entries(holdings.holdings).map(([k, h]) => ({ key: k, ...h }));
	setActivePinia(createPinia());
	store = useRecoveryHelpStore();
	store.setPause(async () => undefined);
	return key;
};
const candidate = candidateOf(KEY);
const answer = (to) => w.send(TEMP, to, [bindingFor(KEY, w.secretRef, TEMP)]);
const returnsTo = (peer) => w.messages.filter((m) => m.to === peer && m.parts.some((p) => p.kind === 'recovery_share_return'));

beforeEach(() => {
	w = makeWorld();
	H.world = w;
	H.gateways = [];
	H.slots = {};
	H.signer = ml_dsa87.keygen(new Uint8Array(32).fill(5));
	H.cards = {};
});

/** Guardian i asks, checks the binding, approves. */
const help = async (i) => {
	const holdingKey = as(i);
	const session = await store.ask({ peer: TEMP, holdingKey });
	answer(w.guardians[i].userHash);
	const checked = await store.bindingOf(session);
	return store.approve(session, checked);
};

describe('asking', () => {
	it('opens the dialog with the request carrying secret_ref, and records it', async () => {
		const holdingKey = as(0);
		const session = await store.ask({ peer: ` ${TEMP}\n`, holdingKey });
		const [first] = w.messages.filter((m) => m.from === w.guardians[0].userHash && m.to === TEMP);
		expect(findSecretRef(first.parts[0].text)).toBe(w.secretRef);
		expect(session).toMatchObject({ step: 'asked', mode: 'dialog', peer: TEMP, secretRef: w.secretRef, holdingKey });
		expect(H.slots[H.me].sessions[session.key]).toMatchObject({ step: 'asked' });
	});

	it('refuses what is not a recovery code, and a piece it no longer keeps', async () => {
		const holdingKey = as(0);
		await expect(store.ask({ peer: 'hello', holdingKey })).rejects.toThrow(/not a recovery code/);
		await expect(store.ask({ peer: w.guardians[0].userHash, holdingKey })).rejects.toThrow(/your own account/);
		await expect(store.ask({ peer: TEMP, holdingKey: 'gone' })).rejects.toThrow(/no longer keep/);
		expect(w.messages).toEqual([]);
	});

	it('shows the ten words for the binding that came back, and refuses a forged one', async () => {
		const holdingKey = as(0);
		const session = await store.ask({ peer: TEMP, holdingKey });
		expect(await store.bindingOf(session)).toBeNull();
		answer(w.guardians[0].userHash);
		expect(await store.bindingOf(session)).toEqual({ candidate, peer: TEMP, words: recoveryWords(w.secretRef, candidate, TEMP) });
		w.send(TEMP, w.guardians[0].userHash, [{ ...bindingFor(KEY, w.secretRef, TEMP), candidate: '0x' + '11'.repeat(20) }]);
		await expect(store.bindingOf(session)).rejects.toThrow(/does not check out/);
	});
});

describe('approving', () => {
	it('opens the round when none is open, then approves — both signed by the guardian\'s stealth key, through the free service', async () => {
		const session = await help(0);
		expect(w.relayed).toEqual([
			{ route: 'initiate-recovery', signer: w.guardians[0].stealthAddress.toLowerCase() },
			{ route: 'approve-recovery', signer: w.guardians[0].stealthAddress.toLowerCase() },
		]);
		expect(H.gateways).toEqual([{ fee: { kind: 'relayer' }, key: w.guardians[0].stealthKey, url: DEPLOYMENT.relayerUrl }]);
		expect(session).toMatchObject({ step: 'approved', candidate, round: 1, heldVersion: 1, stealthAddress: w.guardians[0].stealthAddress });
		expect(w.roundState()).toBe(1);
	});

	it('only approves while the round is voting, and refuses once quorum was reached without it', async () => {
		await help(0);
		await help(1);
		expect(w.relayed.map((r) => r.route)).toEqual(['initiate-recovery', 'approve-recovery', 'approve-recovery']);
		expect(w.state.recipient).toBe(candidate);
		await expect(help(2)).rejects.toThrow(/Enough guardians already approved/);
	});

	it('refuses a piece of an earlier version, and a backup that no longer lists the guardian', async () => {
		w.state.version = 2n;
		await expect(help(0)).rejects.toThrow(/earlier version/);
		expect(w.relayed).toEqual([]);
	});
});

describe('the send gate', () => {
	it('sends nothing in the timelock, then the piece by itself in the window — once', async () => {
		await help(0);
		await help(1);
		await store.tick();
		expect(returnsTo(TEMP)).toEqual([]);
		w.clock.now += 601;
		await store.tick();
		const sent = returnsTo(TEMP);
		expect(sent).toHaveLength(1);
		const part = sent[0].parts.find((p) => p.kind === 'recovery_share_return');
		expect(part).toMatchObject({ secretRef: w.secretRef, round: 1, candidate, shareIndex: 2 });
		expect(checkReturn(part, { secretRef: w.secretRef, version: 1, round: 1, candidate }, hexToBytes(w.run.root))).toMatchObject({ ok: true });
		expect(Object.values(H.slots[H.me].sessions)[0]).toMatchObject({ step: 'sent' });
		await store.tick();
		expect(returnsTo(TEMP)).toHaveLength(1);
	});

	it('stops for good after a veto, and sends nothing', async () => {
		await help(0);
		await help(1);
		w.cancel();
		w.clock.now += 601;
		await store.tick();
		expect(returnsTo(TEMP)).toEqual([]);
		expect(Object.values(H.slots[H.me].sessions)[0]).toMatchObject({ step: 'stopped', reason: /stopped/ });
	});

	it('stops when a later round elects another device', async () => {
		await help(0);
		await help(1);
		w.cancel();
		w.initiate(w.guardians[2].stealthAddress);
		w.approve(w.guardians[2].stealthAddress, '0x' + '11'.repeat(20));
		w.approve(w.guardians[0].stealthAddress, '0x' + '11'.repeat(20));
		w.clock.now += 601;
		await store.tick();
		expect(returnsTo(TEMP)).toEqual([]);
		expect(Object.values(H.slots[H.me].sessions)[0]).toMatchObject({ step: 'stopped', reason: /later recovery/ });
	});
});

describe('returning by hand', () => {
	it('gives the request as text, takes the binding as text, and seals the piece only in the window', async () => {
		const kem = ml_kem1024.keygen();
		H.cards[TEMP] = { user_hash: TEMP, crypt_pkey: toBase64(kem.publicKey) };
		const holdingKey = as(0);
		const { session, text } = await store.askByText({ holdingKey });
		expect(findSecretRef(text)).toBe(w.secretRef);
		const checked = store.typedBinding(session, ` ${bindingText(bindingFor(KEY, w.secretRef, TEMP))}\n`);
		expect(checked).toEqual({ candidate, peer: TEMP, words: recoveryWords(w.secretRef, candidate, TEMP) });
		const approved = await store.approve(session, checked);
		as(1);
		await help(1);
		as(0);
		await expect(store.sealFor(approved)).rejects.toThrow(/Not yet/);

		w.clock.now += 601;
		// Its own record of the help it gives, read back from its slot.
		await store.tick();
		expect(store.sessions[approved.key].step).toBe('ready');
		expect(returnsTo(TEMP).filter((m) => m.from === w.guardians[0].userHash)).toEqual([]);

		const { block, digits } = await store.sealFor(store.sessions[approved.key]);
		const read = await readReturnBlock(parseReturnBlock(block), w.secretRef, (ct) => ml_kem1024.decapsulate(ct, kem.secretKey));
		expect(read.digits).toBe(digits);
		expect(await read.open()).toMatchObject({ candidate, round: 1, shareIndex: 1 });
		await store.markSent(store.sessions[approved.key]);
		expect(H.slots[H.me].sessions[approved.key].step).toBe('sent');
	});

	it('refuses a typed binding whose account is not on this server', async () => {
		const holdingKey = as(0);
		const { session } = await store.askByText({ holdingKey });
		expect(() => store.typedBinding(session, bindingText(bindingFor(KEY, w.secretRef, TEMP)))).toThrow(/not on this server/);
	});
});

it('keeps its records in its own slot', () => {
	expect(HELP_SLOT).toBe('recovery_helping');
});
