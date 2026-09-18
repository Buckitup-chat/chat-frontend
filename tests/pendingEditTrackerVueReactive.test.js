import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import {
	claimPendingEdit,
	submitPendingEdit,
	failPendingEdit,
	reconcilePendingEditsWithVerifiedRows,
} from '@/lib/data/pendingEditTracker';

function reconcile(pending, decrypted) {
	if (pending.value.size === 0) return [];
	const verifiedRevisions = decrypted.value
		.filter((m) => m.verified)
		.map((m) => ({ id: m.id, signHash: m.signHash }));
	const cleared = reconcilePendingEditsWithVerifiedRows(pending.value, verifiedRevisions);
	if (cleared.length) pending.value = new Map(pending.value);
	return cleared;
}

async function runEdit(pending, decrypted, messageId, text, dispatch) {
	const token = claimPendingEdit(pending.value, messageId, text);
	pending.value = new Map(pending.value);
	try {
		const { signHash, ownerTimestamp } = await dispatch();
		if (!submitPendingEdit(pending.value, messageId, token, signHash, ownerTimestamp)) return { outcome: 'stale' };
		pending.value = new Map(pending.value);
		reconcile(pending, decrypted);
		return { outcome: 'submitted' };
	} catch (e) {
		if (!failPendingEdit(pending.value, messageId, token, e)) return { outcome: 'stale' };
		pending.value = new Map(pending.value);
		return { outcome: 'failed' };
	}
}

function overlayText(pending, decryptedMessage) {
	const p = pending.value.get(decryptedMessage.id);
	return p ? p.text : decryptedMessage.text;
}

describe('pendingEditTracker + Vue reactive Map: sign_hash identity vs dispatch completion (U1 follow-up, F01/F02)', () => {
	it('a current edit that fails is marked failed, not left syncing forever', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		const result = await runEdit(pending, decrypted, 'm1', 'hello', () => Promise.reject(new Error('permanent')));

		expect(result.outcome).toBe('failed');
		expect(pending.value.get('m1')).toMatchObject({ text: 'hello', status: 'error' });
	});

	it('A\'s late failure does not mark a newer B as failed or lose B\'s text', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);
		let rejectA;
		const gateA = new Promise((_resolve, reject) => { rejectA = reject; });

		const editA = runEdit(pending, decrypted, 'm1', 'edit A', () => gateA);
		const tokenB = claimPendingEdit(pending.value, 'm1', 'edit B');
		pending.value = new Map(pending.value);

		rejectA(new Error('A failed late'));
		const resultA = await editA;

		expect(resultA.outcome).toBe('stale');
		expect(pending.value.get('m1')).toMatchObject({ text: 'edit B', status: 'syncing', token: tokenB });
	});

	it('A remains visible after dispatch completion while the source row is still original', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		const result = await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));

		expect(result.outcome).toBe('submitted');
		expect(pending.value.get('m1').status).toBe('awaiting_echo');
		expect(overlayText(pending, decrypted.value[0])).toBe('edit A');
	});

	it('the exact verified target revision (matched by sign_hash) replaces the projection and only then removes the pending entry', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));

		decrypted.value = [{ id: 'm1', text: 'edit A', signHash: 'sig_A', verified: true }];
		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(false);
		expect(overlayText(pending, decrypted.value[0])).toBe('edit A');
	});

	it('an unverified row with the right sign_hash does not remove the overlay', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));

		decrypted.value = [{ id: 'm1', text: 'edit A', signHash: 'sig_A', verified: false }];
		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(true);
		expect(overlayText(pending, decrypted.value[0])).toBe('edit A');
	});

	it('a verified predecessor revision (different sign_hash) does not clear a newer pending edit', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));

		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(true);
		expect(pending.value.get('m1').targetSignHash).toBe('sig_A');
	});

	it('A\'s verified echo landing after B was claimed does not clear B', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));
		await runEdit(pending, decrypted, 'm1', 'edit B', () => Promise.resolve({ signHash: 'sig_B', ownerTimestamp: 202 }));
		expect(pending.value.get('m1').targetSignHash).toBe('sig_B');

		decrypted.value = [{ id: 'm1', text: 'edit A', signHash: 'sig_A', verified: true }];
		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(true);
		expect(pending.value.get('m1')).toMatchObject({ text: 'edit B', targetSignHash: 'sig_B' });
		expect(overlayText(pending, decrypted.value[0])).toBe('edit B');
	});

	it('a verified row from another device with the same owner_timestamp but a different sign_hash does not clear the overlay', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 500 }));

		decrypted.value = [{ id: 'm1', text: 'edit X from another device', signHash: 'sig_X', verified: true }];
		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(true);
		expect(pending.value.get('m1').targetSignHash).toBe('sig_A');
		expect(overlayText(pending, decrypted.value[0])).toBe('edit A');
	});

	it('identical plaintext across two different revisions does not create a false match', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'hello', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'hello', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 })); // restores the same text
		decrypted.value = [{ id: 'm1', text: 'hello', signHash: 'sig_A', verified: true }];
		reconcile(pending, decrypted);
		expect(pending.value.has('m1')).toBe(false);

		await runEdit(pending, decrypted, 'm1', 'hello', () => Promise.resolve({ signHash: 'sig_B', ownerTimestamp: 202 }));
		reconcile(pending, decrypted);

		expect(pending.value.has('m1')).toBe(true);
		expect(pending.value.get('m1').targetSignHash).toBe('sig_B');
	});

	it('editing the same message again after the previous edit fully verified is a fresh revision', async () => {
		const pending = ref(new Map());
		const decrypted = ref([{ id: 'm1', text: 'original', signHash: 'sig_0', verified: true }]);

		await runEdit(pending, decrypted, 'm1', 'edit A', () => Promise.resolve({ signHash: 'sig_A', ownerTimestamp: 101 }));
		decrypted.value = [{ id: 'm1', text: 'edit A', signHash: 'sig_A', verified: true }];
		reconcile(pending, decrypted);
		expect(pending.value.has('m1')).toBe(false);

		const second = await runEdit(pending, decrypted, 'm1', 'edit B', () => Promise.reject(new Error('boom')));
		expect(second.outcome).toBe('failed');
		expect(pending.value.get('m1')).toMatchObject({ text: 'edit B', status: 'error' });
	});
});
