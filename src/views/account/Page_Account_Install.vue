<template>
	<FullContentBlock>
		<template #header>
			<div class="ui-title">Install app</div>
		</template>
		<template #content>
			<div class="_page">
				<section class="_hero" :class="{ 'ui-card': onComputer }">
					<img class="_app_icon" :src="appIcon" alt="" />
					<div class="_hero_text">
						<h2>{{ heading }}</h2>
						<p class="ui-small ui-secondary">{{ pitch }}</p>
					</div>
					<button v-if="mode === 'prompt' && !installing" type="button" class="ui-btn" :class="{ _block: !onComputer }"
						data-test="install" @click="install()">
						Install
					</button>
				</section>

				<div v-if="installing" class="ui-card _state" data-test="installing">
					<span class="_spinner"></span>
					<div>Installing… Confirm in the browser window.</div>
				</div>

				<div v-else-if="mode === 'installed'" class="ui-card _state" data-test="installed">
					<span class="_tile _success"><i class="_icon_verified"></i></span>
					<div>
						<div>Installed on this device</div>
						<div class="ui-small ui-secondary">{{ inApp ? "You're using the app now." : 'Open BuckitUp from its icon.' }}</div>
					</div>
				</div>

				<template v-else-if="mode === 'ios'">
					<ol class="ui-card _steps" data-test="ios-steps">
						<li>
							<span class="_num">1</span>
							<span>Tap <span class="_share"><i class="_icon_share_ios"></i></span> {{ shareWhere }}</span>
						</li>
						<li><span class="_num">2</span><span>Choose <b>Add to Home Screen</b></span></li>
						<li><span class="_num">3</span><span>Open BuckitUp from the new icon and sign in with your passkey</span></li>
					</ol>
					<div class="ui-notice _note">
						<i class="_icon_info"></i>
						The app is the same as here. Your chats stay where they are.
					</div>
				</template>

				<div v-else-if="mode === 'menu'" class="ui-card _text_card" data-test="install-menu">
					<div>Install from the browser menu</div>
					<div class="ui-small ui-secondary">{{ menuHint }}</div>
				</div>

				<div v-else-if="mode === 'unsupported'" class="ui-card _text_card" data-test="install-unsupported">
					<div>{{ device.browser }} can't install apps</div>
					<div class="ui-small ui-secondary">
						Open this page in {{ device.name === 'iPhone' || device.name === 'iPad' ? 'Safari' : 'Chrome, Edge or Safari' }}.
						You can keep using BuckitUp here as it is.
					</div>
				</div>

				<section v-if="onComputer" class="_phone">
					<h2 class="ui-title-sm">On your phone</h2>
					<div class="ui-card _phone_card">
						<canvas ref="qrCanvas" class="_qr" aria-label="A code that opens BuckitUp"></canvas>
						<p class="ui-small ui-secondary">
							Scan with the phone camera to open BuckitUp there, then follow the steps on the phone. To use this
							account on the phone, connect it in
							<router-link :to="{ name: 'account_info' }">Identity → Connect a device</router-link>.
						</p>
					</div>
				</section>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._page {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	width: 100%;
	max-width: 30rem;

	@include media-breakpoint-up(md) {
		gap: var(--space-5);
		max-width: 48rem;
	}
}

._hero {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: var(--space-4);

	&.ui-card { flex-wrap: nowrap; padding: var(--space-5); }

	h2 {
		margin: 0;
		font-size: var(--text-xl);
		line-height: var(--leading-xl);
		font-weight: var(--weight-medium);
	}

	p { margin: 0; }
	.ui-btn { flex-shrink: 0; }
}

._hero_text {
	flex: 1;
	min-width: 0;
}

._app_icon {
	flex-shrink: 0;
	width: 72px;
	height: 72px;
	border-radius: 16px;
}

._state {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-4);
}

._tile {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	border-radius: 50%;

	&._success { background: var(--color-success-bg); i { background-color: var(--color-success); } }
	i { width: 18px; height: 18px; }
}

._spinner {
	flex-shrink: 0;
	width: 20px;
	height: 20px;
	border: 2px solid var(--color-border);
	border-top-color: var(--color-accent);
	border-radius: 50%;
	animation: _spin 0.9s linear infinite;
}

@keyframes _spin { to { transform: rotate(360deg); } }

._steps {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	margin: 0;
	padding: var(--space-4);
	list-style: none;

	li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}

	b { font-weight: var(--weight-semibold); }
}

._num {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 28px;
	height: 28px;
	border-radius: 50%;
	background: var(--color-text);
	color: var(--color-bg);
	font-size: var(--text-sm);
}

._share {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	margin: -4px 4px;
	vertical-align: middle;
	border-radius: var(--radius-xs);
	background: var(--color-surface);

	// Safari's own blue: the button looks the same in the browser
	i { width: 20px; height: 20px; background-color: #0a84ff; }
}

._note {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	border: 1px solid var(--color-border);
	background: transparent;

	i { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; background-color: currentColor; }
}

._text_card {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-4);
}

._phone {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);

	h2 { margin: 0; }
}

._phone_card {
	display: flex;
	align-items: center;
	gap: var(--space-5);
	padding: var(--space-4) var(--space-5);

	p { margin: 0; }
	a { color: var(--color-accent); }
}

._qr {
	flex-shrink: 0;
	width: 112px !important;
	height: 112px !important;
}
</style>

<script setup>
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import FullContentBlock from '@/components/FullContentBlock.vue';
import { useInstallPrompt } from '@/composables/useInstallPrompt';
import { describeThisDevice } from '@/lib/thisDevice';

const { inApp, mode, installing, install } = useInstallPrompt();
const device = describeThisDevice();
const ios = device.name === 'iPhone' || device.name === 'iPad';
// An iPad reports itself a computer, but installs like an iPhone.
const onComputer = device.kind === 'computer' && !ios;

const appUrl = new URL(import.meta.env.BASE_URL, location.origin).href;
const appIcon = `${import.meta.env.BASE_URL}img/pwa/pwa-192.png`;

const heading = computed(() => {
	if (ios) return `BuckitUp on ${device.name}`;
	return onComputer ? 'BuckitUp for this computer' : 'BuckitUp on this phone';
});
const pitch = computed(() => {
	if (!onComputer) return 'Opens from the Home Screen, without the browser bar.';
	const icon = device.name === 'Mac' ? 'Dock icon' : 'icon';
	return `Its own window and ${icon}. Works offline with chats already on this device.`;
});
// Safari on an iPhone has its toolbar at the bottom, on an iPad at the top.
const shareWhere = device.name === 'iPad' ? 'at the top of Safari' : 'at the bottom of Safari';
const menuHint = computed(() => {
	if (device.browser === 'Safari') return 'In the menu bar, choose File → Add to Dock.';
	if (!onComputer) return 'Open the browser menu and choose Install app or Add to Home screen.';
	return 'Open the browser menu and choose Install BuckitUp. If there is no such item, BuckitUp is installed on this device already.';
});

const qrCanvas = ref(null);
onMounted(() => {
	if (qrCanvas.value) QRCode.toCanvas(qrCanvas.value, appUrl, { errorCorrectionLevel: 'M', width: 224, margin: 0 });
});
</script>
