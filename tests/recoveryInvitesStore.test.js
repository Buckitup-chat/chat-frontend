// The account's roster takes each judged outcome once, however often a
// dialog re-judges, and a failed write is retried by the next judging.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const OWNER = 'u_' + 'a'.repeat(128);
const GUARDIAN = 'u_' + 'b'.repeat(128);
const INVITE = '11'.repeat(16);
const DEPLOYMENT = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const META = '0x02' + '1'.repeat(64) + '03' + '2'.repeat(64);

const slots = {};
const em = {
	loadSlotJson: vi.fn(async (name) => slots[name] ?? null),
	patchSlotJson: vi.fn(async (name, patch) => {
		const cur = slots[name] ?? {};
		slots[name] = { ...cur, answers: { ...(cur.answers ?? {}), ...(patch.answers ?? {}) }, invites: { ...(cur.invites ?? {}), ...(patch.invites ?? {}) } };
		return slots[name];
	}),
};
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => em } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUserHash: OWNER, contactsMap: { [GUARDIAN]: { confirmed: true } } }) }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ sendMessage: vi.fn() }) }));

const { useRecoveryInvitesStore } = await import('@/store/recoveryInvites.store');

const judged = new Map([[INVITE, { state: 'accepted', metaAddress: META, problems: [] }]]);

beforeEach(() => {
	setActivePinia(createPinia());
	for (const k of Object.keys(slots)) delete slots[k];
	slots.recovery_roster = { invites: { [INVITE]: { contact: GUARDIAN, deployment: DEPLOYMENT, messageId: 'dmsg_01' } } };
	em.patchSlotJson.mockClear();
});

describe('the roster write-back', () => {
	it('waits for the roster, then writes an outcome once', async () => {
		const store = useRecoveryInvitesStore();
		await store.recordJudged(judged);
		expect(em.patchSlotJson).not.toHaveBeenCalled();
		await store.load();
		await Promise.all([store.recordJudged(judged), store.recordJudged(judged)]);
		await store.recordJudged(judged);
		expect(em.patchSlotJson).toHaveBeenCalledTimes(1);
		expect(store.roster.answers[INVITE]).toEqual({ state: 'accepted', contact: GUARDIAN, deployment: DEPLOYMENT, metaAddress: META });
	});

	it('retries an outcome whose write failed', async () => {
		const store = useRecoveryInvitesStore();
		await store.load();
		em.patchSlotJson.mockRejectedValueOnce(new Error('offline'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await store.recordJudged(judged);
		await store.recordJudged(judged);
		expect(em.patchSlotJson).toHaveBeenCalledTimes(2);
		expect(store.roster.answers?.[INVITE]?.state).toBe('accepted');
	});

	it('approves only on its own deployment and asks only confirmed contacts', () => {
		const store = useRecoveryInvitesStore();
		expect(store.approvesOn(store.deployment)).toBe(true);
		expect(store.approvesOn('eip155:10:0x45907bd5636ccece1819fcd6433dec71c78f3bb3')).toBe(false);
		expect(store.isConfirmed(GUARDIAN)).toBe(true);
		expect(store.isConfirmed('u_' + 'c'.repeat(128))).toBe(false);
	});
});
