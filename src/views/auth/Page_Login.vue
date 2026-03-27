<template>
	<div>
		<div class="passkey-warning" v-if="!$user.account && !isPlatformAuthSupported">
			<div class="_icon_logo bg-white"></div>

			<div class="warning-content">
				<h3>Your device does not support convenient passkey verification</h3>

				<p>
					Unfortunately, on your computer (likely Linux without additional setup)
					the browser does not detect a built-in way to verify your identity.
				</p>

				<p>
					To use passkeys comfortably, we recommend installing one of these password managers:
				</p>

				<div class="recommendations">
					<div class="app-card">
						<strong>KeePassXC</strong><br>
						<small>Free, open-source, best passkey support on Linux</small>
						<a href="https://keepassxc.org/download/" target="_blank" class="btn">Download KeePassXC</a>
					</div>

					<div class="app-card">
						<strong>Bitwarden</strong><br>
						<small>Convenient, syncs across devices, works great in the browser</small>
						<a href="https://bitwarden.com/download/" target="_blank" class="btn">Download Bitwarden</a>
					</div>
				</div>

				<p class="small-note">
					After installation, enable passkey support in the application settings
					and the browser extension — then passkeys will work almost like on Windows or macOS.
				</p>
			</div>
		</div>
	</div>

	<div class="d-flex flex-column justify-content-center align-items-center _block px-2 pt-5"
		v-if="!$user.account && isPlatformAuthSupported">
		<div class="_icon_logo bg-white"></div>

		<div class="px-3 w-100 mb-3" v-if="$user.vaults.length && mode !== 'existing'">
			<button class="btn btn-outline-light w-100" @click="setMode('existing')">Connect existing account</button>
		</div>

		<div class="_input_block mb-3 w-100" v-if="$user.vaults.length && mode === 'existing'">
			<div class="fs-4 text-center mb-2">Connect existing account</div>
			<Account_Selector />
		</div>



		<div class="px-3 w-100 mb-3">
			<button class="btn btn-outline-light w-100" @click="setMode('create')">
				Create new account
			</button>
		</div>

		<div class="px-3 w-100 mb-3">
			<button class="btn btn-outline-light w-100" @click="setMode('restore')">Import from local backup</button>
		</div>

		<div class="px-3 w-100 mb-3">
			<button class="btn btn-outline-light w-100" @click="setMode('shares')">Restore from shares</button>
		</div>

		<div class="px-3 w-100 mb-3">
			<button class="btn btn-outline-light w-100" @click="setMode('connect')">Sync with other device</button>
		</div>

		<div class="px-3 w-100 mb-3 opacity-50">
			<button class="btn btn-outline-light w-100" @click="wipe()">Wipe all</button>
		</div>
		<div class="px-3 w-100 mb-3 opacity-50">
			<button class="btn btn-outline-light w-100" @click="connectVaultLocalApp()">Local app connect</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._block {
	width: 100%;
	max-width: 23rem;
	height: 100%;

	._icon_logo {
		min-height: 6rem;
		min-width: 6rem;
		margin-bottom: 2rem;
	}
}

.passkey-warning {
	background: rgba(74, 44, 107, 0.65);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	border: 1px solid rgba(154, 85, 255, 0.25);
	border-radius: 16px;
	padding: 24px;
	margin: 32px auto;
	color: #e0d4ff;
	max-width: 720px;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
	font-family: system-ui, -apple-system, sans-serif;
	position: relative;
	overflow: hidden;

	._icon_logo {
		min-height: 6rem;
		min-width: 6rem;
		margin-bottom: 2rem;
	}
}

.passkey-warning::before {
	content: "";
	position: absolute;
	inset: 0;
	background: linear-gradient(135deg, rgba(106, 61, 158, 0.15), rgba(157, 94, 255, 0.08));
	pointer-events: none;
	z-index: -1;
}

.warning-icon {
	font-size: 3rem;
	float: left;
	margin: 0 20px 12px 0;
	line-height: 1;
	color: #c084fc;
}

.warning-content h3 {
	margin: 0 0 16px 0;
	color: #d1b3ff;
	font-size: 1.45rem;
	font-weight: 600;
}

.warning-content p {
	margin: 0 0 18px 0;
	line-height: 1.6;
	color: #c9b8ff;
}

.recommendations {
	display: flex;
	flex-wrap: wrap;
	gap: 24px;
	margin: 24px 0;
}

.app-card {
	background: rgba(90, 50, 130, 0.4);
	border: 1px solid rgba(180, 100, 255, 0.18);
	border-radius: 12px;
	padding: 20px;
	flex: 1;
	min-width: 240px;
	backdrop-filter: blur(8px);
	transition: all 0.25s ease;
}

.app-card:hover {
	transform: translateY(-4px);
	box-shadow: 0 12px 32px rgba(100, 50, 200, 0.3);
	border-color: rgba(180, 100, 255, 0.4);
}

.app-card strong {
	font-size: 1.25rem;
	display: block;
	margin-bottom: 6px;
	color: #e0ccff;
}

.app-card small {
	color: #b19cd9;
	display: block;
	margin-bottom: 16px;
	font-size: 0.92rem;
}

.passkey-warning .btn {
	display: inline-block;
	background: linear-gradient(90deg, #9d5eff, #c084fc);
	color: white;
	padding: 10px 20px;
	border-radius: 10px;
	text-decoration: none;
	font-weight: 600;
	transition: all 0.25s ease;
	box-shadow: 0 4px 12px rgba(157, 94, 255, 0.35);
}

.passkey-warning .btn:hover {
	transform: translateY(-2px);
	box-shadow: 0 8px 24px rgba(157, 94, 255, 0.5);
	background: linear-gradient(90deg, #b47eff, #d9a0ff);
}

.small-note {
	font-size: 0.95rem;
	color: #b19cd9;
	margin-top: 20px;
	line-height: 1.5;
	opacity: 0.9;
}

@media (max-width: 520px) {
	.recommendations {
		flex-direction: column;
	}

	.passkey-warning {
		padding: 20px;
		margin: 20px 12px;
	}
}
</style>

<script setup>
import Account_Selector from '@/components/Account_Selector.vue';
import { inject, ref, onMounted, onUnmounted, computed, nextTick } from 'vue';
import * as $enigma from '@/libs/enigma';

const $mitt = inject('$mitt');
const $user = inject('$user');
const $swal = inject('$swal');
const $route = inject('$route');
const $loader = inject('$loader');
const $isProd = inject('$isProd');
const $router = inject('$router');
const $encryptionManager = inject('$encryptionManager');

const mode = ref();
const isPlatformAuthSupported = ref(false)

onMounted(async () => {
	isPlatformAuthSupported.value = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()

	await updateData();

	if ($route.query.sessionId) {
		mode.value = 'connect';
		$mitt.emit('modal::open', { id: 'account_connect' });
	} else if ($user.vaults.length) {
		mode.value = 'existing';
	}

	$mitt.on('account::created', updateData);
});

onUnmounted(async () => {
	$mitt.off('account::created', updateData);
});

const updateData = async () => {
	$user.vaults = await $encryptionManager.getVaults();
};

const wipe = async () => {
	await $user.clearIndexedDB();
	location.reload();
};

function setMode(m) {
	mode.value = m;
	if (m === 'create') $mitt.emit('modal::open', { id: 'account_create' });
	if (m === 'restore') $mitt.emit('modal::open', { id: 'account_restore_local' });
	if (m === 'shares') $mitt.emit('modal::open', { id: 'account_restore_shares' });
	if (m === 'connect') $mitt.emit('modal::open', { id: 'account_connect' });
}

const connectVaultLocalApp = async () => {
	const vaults = await $encryptionManager.getVaults();
	if (!vaults?.length) return;
	let currentUser = vaults.find((u) => u.current);
	if (!currentUser) currentUser = vaults[0];

	await $encryptionManager.connectToVault(currentUser.vaultId);

	if (!$encryptionManager.isAuth) return;

	const vault = await $encryptionManager.getData();

	const privateKeyB64 = $enigma.stringToBase64($enigma.hexToUint8Array(vault.privateKey.slice(2)));
	const publicKeyB64 = $enigma.stringToBase64($enigma.getPublicKeyFromPrivateKey(vault.privateKey.slice(2)));

	const resp = [[currentUser.name, $enigma.combineKeypair(privateKeyB64, publicKeyB64)], vault.rooms || [], vault.contacts || []];
	console.log('connectVaultLocalApp', resp);
	return resp;
};
</script>
