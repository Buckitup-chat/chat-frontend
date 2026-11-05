// One phone for the Chromium check: a test identity (keys made here, a card
// signed by the app's own code) running the app's HandshakeEngine over the
// app's QwbpChannel — the patched QWBP, real WebRTC. The check reads and
// feeds codes through window.__pq2 in place of the cameras.
//
// Query: ?name=…  ·  &turn=<url>&user=…&pass=… (a relay)  ·  &relayOnly (offer
// the relay's addresses only). An impostor's claimed card, too long for a
// URL, comes in sessionStorage under 'pq2.impostor'.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { api } from '@/api/client';
import { HandshakeEngine, type Outcome, type HandshakeIdentity } from '@/lib/handshake/engine';
import { signOptical } from '@buckitup/pq-client/handshake';
import { QwbpChannel } from '@/lib/handshake/qwbpChannel';
import type { UserCardRow } from '@/lib/data/types';

const params = new URLSearchParams(location.search);
const logLines: string[] = [];
const log = (line: string) => {
	logLines.push(line);
	document.getElementById('log')!.textContent += `${line}\n`;
};

// Every RTCPeerConnection the channel makes, for getStats(): the check
// asserts which path the channel took.
const connections: RTCPeerConnection[] = [];
const NativePeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = class extends NativePeerConnection {
	constructor(configuration?: RTCConfiguration) {
		super(configuration);
		connections.push(this);
	}
} as typeof RTCPeerConnection;

const createIdentity = (name: string) => {
	const sign = ml_dsa87.keygen(randomBytes(32));
	const crypt = ml_kem1024.keygen(randomBytes(64));
	const contactSkey = secp.utils.randomPrivateKey();
	const contactPkey = secp.getPublicKey(contactSkey, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const { mutation } = api.createUserCard(name, {
		user_hash: userHash,
		sign_pkey: sign.publicKey,
		sign_skey: sign.secretKey,
		contact_pkey: contactPkey,
		contact_cert: ml_dsa87.sign(contactPkey, sign.secretKey),
		crypt_pkey: crypt.publicKey,
		crypt_cert: ml_dsa87.sign(crypt.publicKey, sign.secretKey),
	});
	const card = (mutation as { modified: UserCardRow }).modified;
	return { userHash, signSkey: sign.secretKey, contactPkey, contactSkey, card };
};

const me = createIdentity(params.get('name') ?? 'Phone');
// Impostor: someone else's identity and card, shown with this page's own key.
const impostor = sessionStorage.getItem('pq2.impostor');
const claimed = impostor ? (JSON.parse(impostor) as UserCardRow) : null;

const identity: HandshakeIdentity = {
	userHash: claimed?.user_hash ?? me.userHash,
	contactPkey: me.contactPkey,
	signOptical: (T) => signOptical(T, me.contactSkey),
	signPq: async (M) => ml_dsa87.sign(M, me.signSkey),
	signedCard: async () => claimed ?? me.card,
};

const turn = params.get('turn');
const iceServers: RTCIceServer[] = turn ? [{ urls: turn, username: params.get('user') ?? '', credential: params.get('pass') ?? '' }] : [];

let code = '';
let outcome: Outcome | null = null;
const engine = new HandshakeEngine({
	identity,
	channel: () => new QwbpChannel({ iceServers, log, relayOnly: params.has('relayOnly') }),
	onShow: (text) => { code = text; },
	onLog: log,
	onDone: (o) => {
		outcome = o;
		log(`done: ${o.kind}`);
	},
});
engine.start();

/** The local and remote candidate types of the pair the channel selected. */
const selectedPair = async () => {
	for (const pc of connections) {
		const stats = await pc.getStats();
		const byId = new Map<string, Record<string, unknown>>();
		stats.forEach((s) => byId.set(s.id, s));
		for (const s of byId.values()) {
			if (s.type !== 'transport' || !s.selectedCandidatePairId) continue;
			const pair = byId.get(s.selectedCandidatePairId as string);
			if (!pair) continue;
			return {
				local: byId.get(pair.localCandidateId as string)?.candidateType,
				remote: byId.get(pair.remoteCandidateId as string)?.candidateType,
			};
		}
	}
	return null;
};

Object.assign(window, {
	__pq2: {
		card: () => me.card,
		code: () => code,
		read: (text: string) => engine.read(text),
		outcome: () => outcome && { ...outcome, peerContactPkey: undefined },
		stage: () => engine.currentStage,
		log: () => [...logLines],
		connections: () => connections.map((pc) => ({ iceServers: pc.getConfiguration().iceServers ?? [] })),
		selectedPair,
	},
});
