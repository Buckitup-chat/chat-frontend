// The recovering device, end to end through its store (plan § 7.5): the
// temporary account made and remembered, the progress in its vault surviving
// a reload, a recovery through the dialogs that lands in the original account
// and destroys the temporary one, and a share returned by hand that is not
// counted until the six digits are confirmed. The chain, the relayer, the
// nodes and the dialogs are the contract-keeping fakes of recoveryWorld.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { toBase64 } from '@/lib/pq/signature';
import { returnOf } from '@/lib/recovery/recovering';
import { checkBinding } from '@/lib/recovery/recoveryBinding';
import { helpRequestText } from '@/lib/recovery/restoring';
import { parseBindingText, sealReturnBlock } from '@/lib/recovery/manualReturn';
import { DEPLOYMENT, hashOf, makeWorld } from './helpers/recoveryWorld';

const TEMP = hashOf('e');
const ORIGINAL = hashOf('o');
// Node, not jsdom: noble and viem check Uint8Array across realms. The store needs only localStorage.
const H = vi.hoisted(() => {
	const items = new Map();
	globalThis.localStorage = {
		getItem: (k) => (items.has(k) ? items.get(k) : null),
		setItem: (k, v) => void items.set(k, String(v)),
		removeItem: (k) => void items.delete(k),
		clear: () => items.clear(),
	};
	return { world: null, vault: new Map(), kem: null, imported: [], deleted: [], acks: [] };
});

const user = reactive({
	currentUserHash: null,
	myLocalUsers: [],
	registerNewUser: async () => {
		user.myLocalUsers.push({ user_hash: TEMP });
		user.currentUserHash = TEMP;
		return { user_hash: TEMP };
	},
	importBackup: async (b) => {
		H.imported.push(b);
		user.myLocalUsers.push({ user_hash: b.identity.user_hash });
		user.currentUserHash = b.identity.user_hash;
		return { status: 'active', userHash: b.identity.user_hash };
	},
	deleteAccount: async (hash) => {
		H.deleted.push(hash);
		user.myLocalUsers = user.myLocalUsers.filter((u) => u.user_hash !== hash);
		H.vault.delete(hash);
	},
	refreshMyLocalUsers: async () => undefined,
	getMyUserByHash: (hash) => user.myLocalUsers.find((u) => u.user_hash === hash),
	getUserByHash: (hash) => H.cards?.[hash],
	login: async (hash) => (user.currentUserHash = hash),
});

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({
		readPeerParts: async (peer, kinds, opts = {}) => {
			const messages = H.world.inbox(user.currentUserHash, peer, kinds).filter((m) => !opts.after || m.messageId >= opts.after);
			H.onRead?.();
			return { messages, delivered: [] };
		},
		sendMessage: async (peer, parts) => H.world.send(user.currentUserHash, peer, parts),
	}),
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			// The temporary account's vault: one per account, gone with it.
			loadRecoveryProgress: async () => JSON.parse(H.vault.get(user.currentUserHash) ?? 'null'),
			saveRecoveryProgress: async (p) => void H.vault.set(user.currentUserHash, JSON.stringify(p)),
			kemDecapsulate: (ct) => ml_kem1024.decapsulate(ct, H.kem.secretKey),
		}),
	},
}));
vi.mock('@/lib/data/inboundDialogs', () => ({ peersWhoWrote: async (me) => H.world.wrote(me), followPeersWhoWrote: () => () => {} }));
vi.mock('@/lib/recovery/deployments', async (orig) => ({ ...(await orig()), maybeRecoveryDeployment: () => DEPLOYMENT }));
vi.mock('@/lib/recovery/chain', async (orig) => ({
	...(await orig()),
	RecoveryChain: class {
		constructor() {
			return H.world.chain;
		}
	},
}));
vi.mock('@/lib/recovery/nodeClient', async (orig) => {
	const real = await orig();
	return { ...real, requestRelease: (node, id, key) => real.requestRelease(node, id, key, { fetch: H.world.nodeFetch }) };
});
vi.mock('@/lib/recovery/vault', () => ({
	// The vault opens with S and nothing else: here, the backup's own S.
	fetchVault: async (s) => {
		if (bytesToHex(s) !== H.world.run.wrapKey) throw new Error('No backup is stored for this key.');
		return { identity: { user_hash: ORIGINAL, name: 'Me' }, keys: { sign_skey: 'x' } };
	},
}));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => reactive({ run: null }) }));
vi.mock('@/store/recoveryRounds.store', () => ({ useRecoveryRoundsStore: () => ({ acknowledge: (a) => H.acks.push(a) }) }));

const { CHECK_MS, RECOVERING_KEY, useRecoveryRestoreStore } = await import('@/store/recoveryRestore.store');
const { finaleKey } = await import('@/store/recoveryFinale.store');

let w;
let store;
beforeEach(async () => {
	w = makeWorld();
	H.world = w;
	H.vault = new Map();
	H.kem = ml_kem1024.keygen();
	H.imported = [];
	H.deleted = [];
	H.acks = [];
	H.cards = { [TEMP]: { user_hash: TEMP, crypt_pkey: toBase64(H.kem.publicKey), name: 'Recovering account' } };
	user.currentUserHash = null;
	user.myLocalUsers = [];
	localStorage.clear();
	setActivePinia(createPinia());
	store = useRecoveryRestoreStore();
	await store.begin();
});

const ask = (i) => w.send(w.guardians[i].userHash, TEMP, [{ kind: 'text', text: helpRequestText(w.secretRef) }]);
const candidate = () => store.view.candidate;
const quorumAndWindow = () => {
	w.initiate(w.guardians[0].stealthAddress);
	w.approve(w.guardians[0].stealthAddress, candidate());
	w.approve(w.guardians[1].stealthAddress, candidate());
	w.clock.now += 601;
};

describe('starting', () => {
	it('makes the temporary account, remembers it on this device, and keeps the candidate key in its vault', async () => {
		expect(localStorage.getItem(RECOVERING_KEY)).toBe(TEMP);
		expect(store.active).toBe(true);
		const saved = JSON.parse(H.vault.get(TEMP));
		expect(saved).toMatchObject({ v: 1, userHash: TEMP, candidateKey: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
	});

	it('goes on after a reload with the same key', async () => {
		const key = JSON.parse(H.vault.get(TEMP)).candidateKey;
		setActivePinia(createPinia());
		const again = useRecoveryRestoreStore();
		expect(again.active).toBe(true);
		expect((await again.load()).candidateKey).toBe(key);
	});
});

describe('a recovery through the dialogs', () => {
	it('lands in the original account, records the finale, and destroys the temporary account', async () => {
		ask(0);
		await store.check();
		const [binding] = w.messages.filter((m) => m.from === TEMP).flatMap((m) => m.parts);
		expect(checkBinding(binding, { secretRef: w.secretRef, dialogPeerUserHash: TEMP })).toBe(candidate());
		quorumAndWindow();
		for (const i of [0, 2]) w.send(w.guardians[i].userHash, TEMP, [returnOf(w.shareOf(i), Number(w.state.round), candidate(), w.clock.now)]);
		// A guardian whose piece does not check is named, and left out of the reshare.
		w.send(w.guardians[1].userHash, TEMP, [{ ...returnOf(w.shareOf(1), Number(w.state.round), candidate(), w.clock.now), round: 99 }]);
		await store.check();
		expect(store.view.ready).toBe(true);
		const elected = candidate();

		await store.openAccount();
		expect(H.imported.map((b) => b.identity.user_hash)).toEqual([ORIGINAL]);
		expect(H.deleted).toEqual([TEMP]);
		expect(H.vault.has(TEMP)).toBe(false);
		expect(localStorage.getItem(RECOVERING_KEY)).toBeNull();
		expect(JSON.parse(localStorage.getItem(finaleKey(ORIGINAL)))).toMatchObject({
			temporary: TEMP,
			secretId: w.id,
			version: 1,
			candidate: elected,
			setAside: [w.guardians[1].userHash],
			temporaryGone: true,
		});
		expect(H.acks).toEqual([{ secretId: w.id, round: Number(w.state.round), recipient: elected }]);
	});

	it('stops looking on its own beat once enough pieces are here', async () => {
		ask(0);
		await store.check();
		quorumAndWindow();
		for (const i of [0, 1]) w.send(w.guardians[i].userHash, TEMP, [returnOf(w.shareOf(i), Number(w.state.round), candidate(), w.clock.now)]);
		await store.check();
		expect(store.view.ready).toBe(true);
		const listeners = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };
		vi.stubGlobal('document', listeners);
		vi.useFakeTimers();
		try {
			const reads = vi.spyOn(w.chain, 'readSecret');
			store.startWatching();
			await vi.advanceTimersByTimeAsync(0);
			const first = reads.mock.calls.length;
			await vi.advanceTimersByTimeAsync(CHECK_MS * 3);
			expect(reads.mock.calls.length).toBe(first);
			store.stopWatching();
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it('sends no answer once another account is signed in mid-pass', async () => {
		ask(0);
		H.onRead = () => {
			user.currentUserHash = ORIGINAL;
		};
		await store.check();
		H.onRead = null;
		expect(w.messages.filter((m) => m.parts.some((p) => p.kind === 'recovery_binding'))).toEqual([]);
		expect(JSON.parse(H.vault.get(TEMP)).answered).toEqual({});
	});

	it('does not open the account short of the pieces', async () => {
		ask(0);
		await store.check();
		quorumAndWindow();
		w.send(w.guardians[0].userHash, TEMP, [returnOf(w.shareOf(0), Number(w.state.round), candidate(), w.clock.now)]);
		await store.check();
		expect(store.view.ready).toBe(false);
		await expect(store.openAccount()).rejects.toThrow(/Not enough pieces/);
		expect(H.imported).toEqual([]);
		expect(H.deleted).toEqual([]);
	});

	it('restarts after the window with a fresh key, answered to every guardian again', async () => {
		ask(0);
		await store.check();
		const first = candidate();
		quorumAndWindow();
		w.clock.now += 3600;
		await store.check();
		expect(store.view.round.phase).toBe('expired');
		await store.restart();
		expect(candidate()).not.toBe(first);
		expect(JSON.parse(H.vault.get(TEMP)).candidateKey).toBe(store.progress.candidateKey);
		const bindings = w.messages.filter((m) => m.from === TEMP).flatMap((m) => m.parts);
		expect(bindings.map((b) => b.candidate)).toEqual([first, candidate()]);
	});
});

describe('a share returned by hand', () => {
	const guardianKey = ml_dsa87.keygen(new Uint8Array(32).fill(3));
	const blockFrom = async (i) => {
		H.cards[w.guardians[i].userHash] = { user_hash: w.guardians[i].userHash, sign_pkey: toBase64(guardianKey.publicKey), name: `Guardian ${i}` };
		return sealReturnBlock({
			cryptPkey: H.cards[TEMP].crypt_pkey,
			part: returnOf(w.shareOf(i), Number(w.state.round), candidate(), w.clock.now),
			guardianUserHash: w.guardians[i].userHash,
			sign: (b) => ml_dsa87.sign(b, guardianKey.secretKey),
		});
	};

	it('answers a request typed in with the binding as text', async () => {
		const text = await store.typeRequest(`from my guardian: ${w.secretRef}`);
		expect(checkBinding(parseBindingText(text), { secretRef: w.secretRef, dialogPeerUserHash: TEMP })).toBe(candidate());
		expect(store.view.secretRef).toBe(w.secretRef);
	});

	it('counts nothing until the six digits are confirmed, and nothing when they differ', async () => {
		await store.typeRequest(w.secretRef);
		quorumAndWindow();
		const { block, digits } = await blockFrom(0);
		expect((await store.readBlock(block)).digits).toBe(digits);
		await store.check();
		expect(store.view.returns.distinct).toBe(0);
		expect(JSON.parse(H.vault.get(TEMP)).typedReturns).toEqual([]);
		store.rejectBlock();
		expect(store.pendingBlock).toBeNull();
		await store.confirmBlock();
		expect(JSON.parse(H.vault.get(TEMP)).typedReturns).toEqual([]);

		await store.readBlock((await blockFrom(0)).block);
		await store.confirmBlock();
		expect(store.view.returns.verified).toEqual([expect.objectContaining({ sender: w.guardians[0].userHash, via: 'text', index: 1 })]);
		expect(JSON.parse(H.vault.get(TEMP)).typedReturns).toHaveLength(1);
	});

	it('opens nothing and says why when the temporary account is no longer signed in', async () => {
		await store.typeRequest(w.secretRef);
		quorumAndWindow();
		await store.readBlock((await blockFrom(0)).block);
		user.currentUserHash = ORIGINAL;
		await expect(store.confirmBlock()).rejects.toThrow(/not signed in on this device now/);
		expect(JSON.parse(H.vault.get(TEMP)).typedReturns).toEqual([]);
	});

	it('refuses a block not signed by the guardian it names', async () => {
		await store.typeRequest(w.secretRef);
		const { block } = await blockFrom(0);
		H.cards[w.guardians[0].userHash].sign_pkey = toBase64(ml_dsa87.keygen(new Uint8Array(32).fill(9)).publicKey);
		await expect(store.readBlock(block)).rejects.toThrow(/not signed by the guardian/);
		expect(store.pendingBlock).toBeNull();
	});
});
