// The proof of possession every authenticated request sends — ingest, read
// sessions and relay credentials: ML-DSA-87 over the challenge string's UTF-8
// bytes, unpadded base64. The server checks exactly those bytes
// (chat: Chat.Pq.ProofOfPossession); a proof over anything else, such as the
// challenge base64-decoded first, is refused.
import { toBase64Unpadded } from './signature';

/** The bytes a proof signs: the challenge as the server sent it, UTF-8. */
export const challengeBytes = (challenge: string): Uint8Array => new TextEncoder().encode(challenge);

/** `sign` is ML-DSA-87 under the account's sign_skey (EncryptionManagerPQ.signChallenge, or the key itself). */
export const proveChallenge = async (
	challenge: string,
	sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<string> => {
	if (typeof challenge !== 'string' || !challenge) throw new Error('no challenge to sign');
	return toBase64Unpadded(await sign(challengeBytes(challenge)));
};
