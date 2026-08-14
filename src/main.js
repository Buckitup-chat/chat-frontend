import { createApp } from 'vue';

import App from './App.vue';

//
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import 'bootstrap';
import './scss/app.scss';

import { web3Store } from './store/web3.store.js';
import { userStore } from './store/user.store.js';
import { userPQStore } from './store/userPQ.store';
import { createPinia } from 'pinia';
import $socket from './libs/socket';
import $mitt from './libs/emitter';
import { useLoader } from './composables/useLoader';
import $swal from './libs/swal';

// dayjs
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.locale('en');
dayjs.extend(relativeTime);

// libs
import globalFilters from './libs/filters';
import * as $enigma from './libs/enigma';
import { EncryptionManager } from './libs/EncryptionManager';
import { EncryptionManagerPQ } from './libs/EncryptionManagerPQ';

const app = createApp(App);

const pinia = createPinia();

// Pinia
app.use(pinia);

// breakpoint
import { useBreakpoint } from './composables/useBreakpoint';
app.config.globalProperties.$breakpoint = useBreakpoint();
app.config.globalProperties.$breakpoint.init();

// mitt
app.provide('$mitt', $mitt);
app.config.globalProperties.$mitt = $mitt;

app.config.globalProperties.$date = dayjs;
app.provide('$date', dayjs);

const $isProd = !location.origin.includes('localhost') && !location.origin.includes('192');
app.provide('$isProd', $isProd);
app.config.globalProperties.$isProd = $isProd;

app.config.globalProperties.$filters = globalFilters;
app.config.globalProperties.$location = window.location;

app.provide('$socket', $socket);

// web3Store
app.config.globalProperties.$web3 = web3Store();

app.config.globalProperties.$user = userStore();

// Create single instance for PQ store
const $userPQ = userPQStore();
app.config.globalProperties.$userPQ = $userPQ;

app.config.globalProperties.$loader = useLoader();

app.provide('$enigma', $enigma);

app.provide('$encryptionManager', new EncryptionManager(IS_PRODUCTION));
app.provide('$encryptionManagerPQ', new EncryptionManagerPQ());

app.config.globalProperties.$swal = $swal;
app.provide('$swal', $swal);

// router
import router from './router';
app.use(router);

import FloatingVue from 'floating-vue';
app.use(FloatingVue);

import InfoTooltip from '@/components/InfoTooltip.vue';
app.component('InfoTooltip', InfoTooltip);

// Multiple tabs are allowed. The single-tab gate that used to live here
// guarded PGlite's one-connection-per-database constraint; PGlite is gone on
// this stack, and every remaining shared resource coordinates across tabs on
// its own: the outbox drains under a Web Locks leader, and shape persistence
// (when enabled) elects a writer via BrowserCollectionCoordinator. A second
// tab is no different from a second device, which the protocol must survive
// anyway — signed rows, monotonic owner_timestamps, idempotent replays.
app.mount('#app');
