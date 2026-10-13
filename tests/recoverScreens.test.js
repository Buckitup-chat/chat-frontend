// @vitest-environment jsdom
// The recovering device's screens (plan § 7.5): the login page's way in —
// after device-link — and the way back to a recovery started here; starting
// one; the progress screen in each state of the round, each piece named by
// its sender; and a piece returned by hand, added only once the person says
// the six digits match.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));
vi.mock('@/components/Account_Selector.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/store/user.store', () => ({ userStore: () => reactive({ vaults: [] }) }));
vi.mock('@/libs/enigma', () => ({}));

const TEMP = 'u_' + 'e'.repeat(128);
const G1 = 'u_' + '1'.repeat(128);
const G2 = 'u_' + '2'.repeat(128);
const H = vi.hoisted(() => ({ restore: null, user: null }));
vi.mock('@/store/recoveryRestore.store', () => ({ useRecoveryRestoreStore: () => H.restore }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));

const { default: Page_Login } = await import('@/views/auth/Page_Login.vue');
const { default: Modal_Recover_Friends } = await import('@/components/modal/views/Modal_Recover_Friends.vue');
const { default: RecoverScreen } = await import('@/components/recovery/restore/RecoverScreen.vue');

const NOW = Math.floor(Date.now() / 1000);
const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse'];
const baseView = (over = {}) => ({
	candidate: '0x' + '5a'.repeat(20),
	requests: [{ peer: G1, secretRef: 'r', messageId: 'dmsg_1' }],
	secretRef: 'r',
	words,
	problem: null,
	round: null,
	version: 1,
	approvals: null,
	returns: null,
	nodes: [],
	nodeThreshold: null,
	nodeShares: 0,
	ready: false,
	...over,
});

let mitt;
let swal;
beforeEach(() => {
	mitt = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
	swal = { fire: vi.fn(async () => ({ isConfirmed: true })) };
	H.user = reactive({ currentUser: null, myLocalUsers: [], login: vi.fn(async () => {}) });
	H.restore = reactive({
		deployment: { chainId: 1 },
		temporary: TEMP,
		active: true,
		view: null,
		checking: false,
		lastError: null,
		pendingBlock: null,
		opening: false,
		openError: null,
		begin: vi.fn(async () => TEMP),
		check: vi.fn(async () => {}),
		restart: vi.fn(async () => {}),
		openAccount: vi.fn(async () => {}),
		typeRequest: vi.fn(async () => 'BUCKITUP-BINDING.r.0x.u.sig'),
		readBlock: vi.fn(async () => {
			H.restore.pendingBlock = { guardian: G2, name: 'Bob', digits: '123456' };
		}),
		confirmBlock: vi.fn(async () => {
			H.restore.pendingBlock = null;
		}),
		rejectBlock: vi.fn(() => {
			H.restore.pendingBlock = null;
		}),
		startWatching: vi.fn(),
		stopWatching: vi.fn(),
		abandon: vi.fn(async () => {}),
		nameOf: (h) => ({ [G1]: 'Alice', [G2]: 'Bob' })[h] ?? 'someone',
	});
	globalThis.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true };
});

describe('the login page', () => {
	const render = () => mount(Page_Login, { global: { provide: { $mitt: mitt, $encryptionManager: { getVaults: async () => [] } } } });

	it('offers Recover with friends after Sync with other device', async () => {
		H.restore.temporary = null;
		const w = render();
		await flushPromises();
		const labels = w.findAll('button').map((b) => b.text());
		expect(labels.indexOf('Recover with friends')).toBe(labels.indexOf('Sync with other device') + 1);
		await w.find('[data-test="recover-with-friends"]').trigger('click');
		expect(mitt.emit).toHaveBeenCalledWith('modal::open', { id: 'account_recover_friends' });
	});

	it('goes back into a recovery started on this device, while its temporary account is here', async () => {
		let w = render();
		await flushPromises();
		expect(w.find('[data-test="continue-recovering"]').exists()).toBe(false);
		H.user.myLocalUsers = [{ user_hash: TEMP }];
		w = render();
		await flushPromises();
		expect(w.find('[data-test="recover-with-friends"]').exists()).toBe(false);
		await w.find('[data-test="continue-recovering"]').trigger('click');
		expect(H.user.login).toHaveBeenCalledWith(TEMP);
	});
});

describe('starting a recovery', () => {
	it('makes the temporary account from a tap and closes', async () => {
		const w = mount(Modal_Recover_Friends, { global: { provide: { $mitt: mitt } } });
		await w.find('[data-test="recover-start"]').trigger('click');
		await flushPromises();
		expect(H.restore.begin).toHaveBeenCalled();
		expect(mitt.emit).toHaveBeenCalledWith('modal::close');
	});

	it('says why it could not start', async () => {
		H.restore.begin = vi.fn(async () => {
			throw new Error('passkey refused');
		});
		const w = mount(Modal_Recover_Friends, { global: { provide: { $mitt: mitt } } });
		await w.find('[data-test="recover-start"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-test="recover-error"]').text()).toContain('passkey refused');
		expect(mitt.emit).not.toHaveBeenCalledWith('modal::close');
	});
});

describe('the progress screen', () => {
	const router = { replace: vi.fn() };
	const render = () => mount(RecoverScreen, { global: { provide: { $mitt: mitt, $swal: swal, $router: router } } });

	it('shows the code before anyone asked, and watches while shown', async () => {
		H.restore.view = baseView({ requests: [], secretRef: null, words: null });
		const w = render();
		expect(H.restore.startWatching).toHaveBeenCalled();
		expect(w.find('[data-test="code"]').text()).toContain(TEMP.slice(0, 14));
		expect(w.find('[data-test="words"]').exists()).toBe(false);
		expect(w.find('[data-test="round"]').text()).toContain('Waiting for your guardian');
		w.unmount();
		expect(H.restore.stopWatching).toHaveBeenCalled();
	});

	it('shows the ten words and who asked, then the approvals while voting', async () => {
		H.restore.view = baseView({ round: { phase: 'voting', round: 1, quorum: 2, executeAfter: 0, expiresAt: 0 }, approvals: 1 });
		const w = render();
		expect(w.findAll('[data-test="words"] li').map((l) => l.text())).toEqual(words);
		expect(w.find('[data-test="words"]').text()).toContain('Guardians who asked: Alice');
		expect(w.find('[data-test="round"]').text()).toContain('1 of 2 guardians approved');
		expect(w.find('[data-test="restart"]').exists()).toBe(false);
	});

	it('counts down the timelock, then lists each piece verified or set aside with its sender, and the nodes', async () => {
		H.restore.view = baseView({ round: { phase: 'timelock', round: 1, quorum: 2, executeAfter: NOW + 3 * 86400 + 60, expiresAt: NOW + 10 * 86400 } });
		let w = render();
		expect(w.find('[data-test="round"]').text()).toContain('Pieces come back in 3 days');

		H.restore.view = baseView({
			round: { phase: 'window', round: 1, quorum: 2, executeAfter: NOW - 60, expiresAt: NOW + 5 * 3600 + 60 },
			returns: {
				verified: [{ sender: G1, via: 'dialog', index: 1 }],
				setAside: [{ sender: G2, via: 'dialog', reason: 'it was released to another device' }],
				distinct: 1,
				threshold: 2,
				nodeSet: null,
			},
			nodes: [
				{ node: { id: 'n_a', url: 'https://a.example/recovery/node' }, state: 'released' },
				{ node: { id: 'n_b', url: 'https://b.example/recovery/node' }, state: 'failed', detail: 'it does not answer' },
			],
			nodeThreshold: 2,
			nodeShares: 1,
		});
		w = render();
		expect(w.find('[data-test="round"]').text()).toContain('for 5 hours more');
		expect(w.findAll('[data-test="piece"]').map((p) => p.text())).toEqual([
			expect.stringMatching(/Alice.*piece 1 verified/),
			expect.stringMatching(/Bob.*set aside: it was released to another device/),
		]);
		expect(w.find('[data-test="pieces"]').text()).toContain('1 of 2 · nodes 1 of 2');
		expect(w.findAll('[data-test="node"]').map((n) => n.text())).toEqual([
			expect.stringMatching(/a\.example.*sent its part/),
			expect.stringMatching(/b\.example.*not yet: it does not answer/),
		]);
		expect(w.find('[data-test="ready"]').exists()).toBe(false);
	});

	it('opens the account once ready, from a tap', async () => {
		H.restore.view = baseView({ round: { phase: 'window', round: 1, quorum: 2, executeAfter: NOW, expiresAt: NOW + 3600 }, ready: true });
		const w = render();
		await w.find('[data-test="open"]').trigger('click');
		await flushPromises();
		expect(H.restore.openAccount).toHaveBeenCalled();
		expect(router.replace).toHaveBeenCalledWith({ name: 'account_info' });
	});

	it('offers to start over after a veto, an expired window or another device', async () => {
		for (const phase of ['stopped', 'expired', 'elsewhere']) {
			H.restore.view = baseView({ round: { phase, round: 1, quorum: 2, executeAfter: 0, expiresAt: 0 } });
			const w = render();
			await w.find('[data-test="restart"]').trigger('click');
			await flushPromises();
			w.unmount();
		}
		expect(H.restore.restart).toHaveBeenCalledTimes(3);
	});
});

describe('a piece returned by hand', () => {
	const render = () => mount(RecoverScreen, { global: { provide: { $mitt: mitt, $swal: swal, $router: { replace: vi.fn() } } } });

	it('answers a typed request with the binding to send back', async () => {
		H.restore.view = baseView();
		const w = render();
		await w.find('[data-test="manual-toggle"]').trigger('click');
		await w.find('[data-test="manual-input"]').setValue('eip155:1:0x…');
		await w.find('[data-test="manual-read"]').trigger('click');
		await flushPromises();
		expect(H.restore.typeRequest).toHaveBeenCalledWith('eip155:1:0x…');
		expect(w.find('[data-test="manual"]').text()).toContain('BUCKITUP-BINDING');
	});

	it('adds nothing until the digits are confirmed, and nothing when they differ', async () => {
		H.restore.view = baseView();
		const w = render();
		await w.find('[data-test="manual-toggle"]').trigger('click');
		await w.find('[data-test="manual-input"]').setValue('BUCKITUP-SHARE.a.b.c.d');
		await w.find('[data-test="manual-read"]').trigger('click');
		await flushPromises();
		expect(H.restore.readBlock).toHaveBeenCalledWith('BUCKITUP-SHARE.a.b.c.d');
		expect(w.find('[data-test="digits-value"]').text()).toBe('123456');
		expect(w.find('[data-test="digits"]').text()).toContain('Ask Bob');
		expect(H.restore.confirmBlock).not.toHaveBeenCalled();

		await w.find('[data-test="digits-differ"]').trigger('click');
		await flushPromises();
		expect(H.restore.rejectBlock).toHaveBeenCalled();
		expect(H.restore.confirmBlock).not.toHaveBeenCalled();
		expect(w.find('[data-test="digits"]').exists()).toBe(false);

		await w.find('[data-test="manual-input"]').setValue('BUCKITUP-SHARE.a.b.c.d');
		await w.find('[data-test="manual-read"]').trigger('click');
		await flushPromises();
		await w.find('[data-test="digits-match"]').trigger('click');
		await flushPromises();
		expect(H.restore.confirmBlock).toHaveBeenCalledTimes(1);
		expect(w.find('[data-test="manual-notice"]').text()).toContain('added');
	});
});
