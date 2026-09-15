// Фаза 4.3: a causal reference (refs_map_b64, or a reaction's
// message_sign_hash) describes what an operation observed — it is not a
// dispatch dependency. The scheduler must only ever depend on what a
// mutation's own contract requires (writeContracts.ts), never on the
// content of a reference field. Two new messages from the same author that
// observed the exact same tail form a legitimate fork (v3, "Causal reference
// и dispatch dependency") and must not be serialized to prevent it.
import { describe, it, expect, beforeEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import { enqueue, readyEntries, _setStorageForTests } from '@/lib/data/outbox';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SAME_TAIL_B64 = 'opaque-encrypted-refs-map-both-authors-observed';

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

// Two distinct messages, same author, same dialog, both carrying the exact
// same refs_map_b64 — a real fork: both observed the same tip before either
// was accepted.
const forkMessage = (messageId: string) => ([{
	type: 'insert',
	modified: {
		message_id: messageId,
		sender_hash: MY_HASH,
		dialog_hash: 'dh1',
		content_b64: 'x',
		refs_map_b64: SAME_TAIL_B64,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const reaction = (messageSignHash: string) => ([{
	type: 'insert',
	modified: {
		reactor_hash: MY_HASH,
		dialog_hash: 'dh1',
		message_sign_hash: messageSignHash,
		reaction_hash: 'rh1',
	},
	syncMetadata: { relation: 'dialog_message_reactions' },
}]);

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('causal reference does not become a dispatch dependency (§4.3)', () => {
	it('two new messages with an identical observed tail (a fork) are not serialized', async () => {
		const firstDeps = await dependenciesFor(forkMessage('dmsg_a'), MY_HASH);
		const firstId = await enqueue(forkMessage('dmsg_a'), MY_HASH, { dependsOn: firstDeps });

		// The second message observed the exact same refs_map_b64 as the
		// first — a legitimate fork, not a request to wait for it.
		const secondDeps = await dependenciesFor(forkMessage('dmsg_b'), MY_HASH);
		expect(secondDeps).not.toContain(firstId);
		expect(secondDeps).toEqual([]);

		await enqueue(forkMessage('dmsg_b'), MY_HASH, { dependsOn: secondDeps });
		const ready = await readyEntries(MY_HASH);
		const messageIds = ready.map((e) => (e.mutations[0] as { modified: { message_id: string } }).modified.message_id);
		expect(messageIds.sort()).toEqual(['dmsg_a', 'dmsg_b']);
	});

	it('a reaction does not depend on the outbox entry of the message it references', async () => {
		const msgId = await enqueue(forkMessage('dmsg_a'), MY_HASH);

		// The reaction names dmsg_a's sign_hash to bind to that revision — it
		// still must not wait for dmsg_a's own dispatch to resolve.
		const deps = await dependenciesFor(reaction('sign-hash-of-dmsg_a'), MY_HASH);
		expect(deps).not.toContain(msgId);
		expect(deps).toEqual([]);

		await enqueue(reaction('sign-hash-of-dmsg_a'), MY_HASH, { dependsOn: deps });
		const ready = await readyEntries(MY_HASH);
		expect(ready.map((e) => e.relation).sort()).toEqual(['dialog_message_reactions', 'dialog_messages']);
	});
});
