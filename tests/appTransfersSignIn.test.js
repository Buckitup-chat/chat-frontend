// @vitest-environment jsdom
// App.vue tells the transfer queue which account is signed in: at start, at
// each sign-in and switch, and at sign-out. The queue brings back that
// account's unfinished uploads and drops another's (transfers.store.js).
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref, nextTick } from 'vue';

const userPQ = reactive({ currentUser: null, isOnline: true, setLegacyLockConsent: vi.fn(), initialize: vi.fn() });
const transfers = { signedIn: vi.fn(async () => {}) };
const stub = { default: { render: () => null } };

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => userPQ }));
vi.mock('@/store/transfers.store', () => ({ useTransfersStore: () => transfers }));
vi.mock('@/store/recoveryRestore.store', () => ({ useRecoveryRestoreStore: () => reactive({ active: false }) }));
vi.mock('@/store/recoveryHoldings.store', () => ({ useRecoveryHoldingsStore: () => ({ watchWhileOpen: () => {} }) }));
vi.mock('@/store/recoveryHelp.store', () => ({ useRecoveryHelpStore: () => ({ watchWhileOpen: () => {} }) }));
vi.mock('@/store/avatars.store', () => ({ useAvatarsStore: () => ({}) }));
vi.mock('@/lib/data/persistence', () => ({ initPersistence: async () => false }));
vi.mock('@/composables/useBreakpoint', () => ({ useBreakpoint: () => reactive({ current: 'md', gt: () => false, lt: () => false }) }));
vi.mock('@/composables/useMenu', () => ({ useMenu: () => ({ isOpen: ref(false), open: () => {}, close: () => {} }) }));
vi.mock('vue-router', () => ({ useRoute: () => ({}), useRouter: () => ({}) }));
vi.mock('@/components/Loader.vue', () => stub);
vi.mock('@/components/QuarantinedWritesBanner.vue', () => stub);
vi.mock('@/components/AccessGateBanner.vue', () => stub);
vi.mock('@/components/PasskeyRecoveryReminder.vue', () => stub);
vi.mock('@/components/RecoveryAlertBanner.vue', () => stub);
vi.mock('@/components/RecoveryFinaleBanner.vue', () => stub);
vi.mock('@/components/recovery/restore/RecoverScreen.vue', () => stub);
vi.mock('@/views/menu/Menu_.vue', () => stub);
vi.mock('@/components/modal/Modal_.vue', () => stub);
vi.mock('@/components/swal/Swal_.vue', () => stub);

const App = (await import('@/App.vue')).default;

describe('App and the transfer queue', () => {
	it('tells the queue the signed-in account at start, at each switch and at sign-out', async () => {
		userPQ.currentUser = { user_hash: 'u_alice' };
		mount(App, { global: { stubs: { 'router-view': true } } });
		expect(transfers.signedIn.mock.calls).toEqual([['u_alice']]);

		userPQ.currentUser = { user_hash: 'u_alice', name: 'Alice' }; // the profile merged in: same account
		await nextTick();
		userPQ.currentUser = { user_hash: 'u_bob' };
		await nextTick();
		userPQ.currentUser = null;
		await nextTick();
		expect(transfers.signedIn.mock.calls).toEqual([['u_alice'], ['u_bob'], [null]]);
	});
});
