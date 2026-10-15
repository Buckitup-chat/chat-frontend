// A reply counts as its first revision (pq_recovery_shares § Inviting): an
// edited reply is judged as it began, and nothing is recorded until every
// edited message's original is known.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { inviteProof, metaKeysOf } from '@/lib/recovery/guardianInvite';

const OWNER = 'u_' + 'a'.repeat(128);
const GUARDIAN = 'u_' + 'b'.repeat(128);
const INVITE = '11'.repeat(16);
const DEPLOYMENT = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const keys = metaKeysOf(new Uint8Array(32).fill(5));
const acceptPart = { kind: 'recovery_invite_reply', inviteId: INVITE, answer: 'accept', metaAddress: keys.metaAddress, proofB64: inviteProof(keys, INVITE, OWNER, GUARDIAN) };

let resolveOriginals;
const store = {
	loaded: true,
	roster: { invites: { [INVITE]: { contact: GUARDIAN, deployment: DEPLOYMENT, messageId: 'dmsg_01' } } },
	answers: {},
	isConfirmed: () => true,
	approvesOn: (d) => d === DEPLOYMENT,
	load: vi.fn(async () => {}),
	recordJudged: vi.fn(),
};
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => store }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUserHash: OWNER }) }));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ firstRevisionsOf: () => new Promise((r) => { resolveOriginals = r; }) }),
}));

const { useGuardianInvites } = await import('@/composables/useGuardianInvites');

const flush = async () => { for (let i = 0; i < 5; i++) await nextTick(); };

beforeEach(() => store.recordJudged.mockClear());

describe('an edited reply', () => {
	it('is judged as it began, and recorded only once that is known', async () => {
		const messages = ref([
			{ id: 'dmsg_1', parts: [{ kind: 'recovery_invite', inviteId: INVITE, deployment: DEPLOYMENT }], _raw: { sender_hash: OWNER, parent_sign_hash: null } },
			// The guardian accepted, then edited the reply into a decline.
			{ id: 'dmsg_2', parts: [{ ...acceptPart, answer: 'decline', metaAddress: '', proofB64: '' }], _raw: { sender_hash: GUARDIAN, parent_sign_hash: 'dms_x' } },
		]);
		const { views } = useGuardianInvites({
			peerHash: ref(GUARDIAN), dialogHash: ref('dh'), messages, peerName: ref('G'), swal: {}, isAlive: () => true,
		});
		await flush();
		expect(views.value.dmsg_1).toMatchObject({ state: 'pending' });
		expect(store.recordJudged).not.toHaveBeenCalled();

		resolveOriginals(new Map([['dmsg_2', [acceptPart]]]));
		await flush();
		expect(views.value.dmsg_1).toMatchObject({ state: 'accepted', metaAddress: keys.metaAddress });
		expect(store.recordJudged).toHaveBeenCalled();
		const judged = store.recordJudged.mock.calls.at(-1)[0];
		expect(judged.get(INVITE)).toMatchObject({ state: 'accepted' });
	});
});
