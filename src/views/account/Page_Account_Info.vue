<template>
	<FullContentBlock v-if="me">
		<template #header>
			<div class="ui-title">Identity</div>
		</template>
		<template #content>
			<div class="_page">
				<section class="_hero">
					<div class="_avatar_col"><OwnAvatarGallery /></div>

					<div class="_who">
						<button v-if="!editing" type="button" class="_name ui-title" title="Edit name" @click="startEdit()">
							<span>{{ me.name || 'Add your name' }}</span>
							<i class="_icon_edit"></i>
						</button>
						<button type="button" class="_id ui-small ui-mono" title="Copy your ID"
							@click="$mitt.emit('swal::open', { id: 'copy_public_key' })">
							{{ shortId }}
							<i class="_icon_copy"></i>
						</button>
					</div>

					<button v-if="!isPhone" type="button" class="ui-btn _outline _share" @click="shareContact()">
						Share contact <i class="_icon_share"></i>
					</button>
				</section>

				<form v-if="editing" class="_edit ui-card" @submit.prevent="saveProfile()">
					<div class="ui-field">
						<label for="identity-name">Name</label>
						<input id="identity-name" ref="nameInput" v-model="draft.name" type="text" :maxlength="MAX_NAME_LENGTH"
							autocomplete="nickname" />
						<div class="_hint">Your contacts see this name.</div>
					</div>
					<div class="ui-field">
						<label for="identity-notes">Private note</label>
						<textarea id="identity-notes" v-model="draft.notes" rows="2" :maxlength="MAX_NOTES_LENGTH"></textarea>
						<div class="_hint">Only you see this.</div>
					</div>
					<div class="_edit_actions">
						<button type="button" class="ui-btn _text" @click="editing = false">Cancel</button>
						<button type="submit" class="ui-btn" :disabled="!hasChanges || saving">Save</button>
					</div>
				</form>

				<div class="_cards">
					<section class="_devices">
						<div v-if="isPhone" class="ui-group-label">Devices</div>
						<div class="ui-card _card">
							<div v-if="!isPhone" class="_card_head">
								<h2 class="ui-title-sm">Devices</h2>
								<button type="button" class="ui-btn _text _sm _accent" @click="connectDevice()">
									<i class="_icon_device_link"></i> Connect a device
								</button>
							</div>
							<UiRow :title="device.name" :sub="device.browser" icon="devices" bare>
								<template #trail><span class="ui-badge">this device</span></template>
							</UiRow>
						</div>
						<button v-if="isPhone" type="button" class="ui-btn _outline _block" @click="connectDevice()">
							Connect a device <i class="_icon_device_link"></i>
						</button>
					</section>

					<div v-if="isPhone" class="ui-card _card">
						<UiRow title="Download backup file" icon="backup_file" bare button :chevron="false" @select="downloadBackup()" />
						<UiRow title="Share contact" icon="share" bare button :chevron="false" @select="shareContact()" />
					</div>
					<section v-else class="ui-card _card _backup">
						<h2 class="ui-title-sm">Backup file</h2>
						<p class="ui-small ui-secondary">
							An encrypted copy of your account. Keep it somewhere safe and remember its password.
						</p>
						<button type="button" class="ui-btn _outline _block" @click="downloadBackup()">
							Download backup file <i class="_icon_backup_file"></i>
						</button>
					</section>
				</div>

				<section class="_danger_zone">
					<template v-if="isPhone">
						<div class="ui-group-label _danger">Danger zone</div>
						<button type="button" class="ui-btn _danger _block" @click="removeAccount()">Remove account from this device</button>
						<div class="ui-caption ui-muted _danger_hint">Your other devices and contacts keep working.</div>
					</template>
					<div v-else class="ui-card _danger_card">
						<div>
							<div class="_danger_title">Remove account from this device</div>
							<div class="ui-small ui-secondary">Your other devices and contacts keep working.</div>
						</div>
						<button type="button" class="ui-btn _danger" @click="removeAccount()">Remove</button>
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
	gap: var(--space-6);
	width: 100%;
	max-width: 30rem;

	@include media-breakpoint-up(md) {
		max-width: 52rem;
	}
}

._hero {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	text-align: center;

	@include media-breakpoint-up(md) {
		flex-direction: row;
		gap: var(--space-5);
		text-align: left;
	}
}

._avatar_col {
	display: flex;
	flex-direction: column;
	align-items: center;
}

._who {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-2);
	min-width: 0;

	@include media-breakpoint-up(md) {
		flex: 1;
		align-items: flex-start;
	}
}

._name {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	max-width: 100%;
	padding: 0;
	border: 0;
	background: none;
	color: var(--color-text);
	font-weight: var(--weight-medium);
	cursor: pointer;

	span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	i { flex-shrink: 0; width: 16px; height: 16px; background-color: var(--color-text-muted); }
	&:hover i { background-color: var(--color-text); }
	&:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: var(--radius-xs); }

	@include media-breakpoint-up(md) {
		font-size: var(--text-2xl);
		line-height: var(--leading-2xl);
	}
}

._id {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 32px;
	padding: 0 var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-pill);
	background: var(--color-bg);
	color: var(--color-text-secondary);
	cursor: pointer;

	i { width: 16px; height: 16px; background-color: currentColor; }
	&:hover { color: var(--color-text); }
	&:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
}

._share {
	flex-shrink: 0;
	align-self: flex-start;
	margin-top: var(--space-2);
}

.ui-btn i { width: 20px; height: 20px; background-color: currentColor; }

._edit {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	padding: var(--space-4);
}

._edit_actions {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--space-3);
}

._cards {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);

	@include media-breakpoint-up(md) {
		display: grid;
		grid-template-columns: 3fr 2fr;
		align-items: start;
		gap: var(--space-5);
	}
}

._devices {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);

	.ui-group-label { margin: 0; }
}

._card {
	padding: var(--space-1) var(--space-4);

	@include media-breakpoint-up(md) {
		padding: var(--space-4) var(--space-5);
	}
}

._card :deep(.ui-row) { --row-pad-x: 0px; }

._card_head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	margin-bottom: var(--space-2);

	h2 { margin: 0; }
}

._accent { color: var(--color-accent); }

._backup {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);

	h2, p { margin: 0; }
}

._danger_zone {
	@include media-breakpoint-down(md) {
		padding-top: var(--space-4);
		border-top: 1px solid var(--color-border);
	}

	.ui-group-label { margin-top: 0; }
}

._danger_hint { margin-top: var(--space-2); }

._danger_card {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-4);
	padding: var(--space-4) var(--space-5);
	border: 1px solid var(--color-danger);
	box-shadow: none;
}

._danger_title { color: var(--color-danger); }
</style>

<script setup>
import { inject, computed, ref, nextTick } from 'vue';
import OwnAvatarGallery from '@/components/OwnAvatarGallery.vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import UiRow from '@/components/ui/UiRow.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { shortUserId } from '@/lib/shortUserId';
import { describeThisDevice } from '@/lib/thisDevice';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from '@/lib/profileFields';

const $userPQ = userPQStore();
const $swal = inject('$swal');
const $swalModal = inject('$swalModal');
const $router = inject('$router');
const $mitt = inject('$mitt');
const $breakpoint = useBreakpoint();

const isPhone = computed(() => $breakpoint.lt('md'));
const me = computed(() => {
	const u = $userPQ.currentUser;
	return u ? { name: u.name ?? '', notes: u.userStorage?.notes ?? '', user_hash: u.user_hash } : null;
});
const shortId = computed(() => shortUserId(me.value?.user_hash));
// The client knows no list of the account's devices: the card names this one.
const device = describeThisDevice();

const editing = ref(false);
const saving = ref(false);
const draft = ref({ name: '', notes: '' });
const nameInput = ref(null);

const startEdit = async () => {
	draft.value = { name: me.value.name, notes: me.value.notes };
	editing.value = true;
	await nextTick();
	nameInput.value?.focus();
};

const hasChanges = computed(() =>
	draft.value.name !== me.value?.name || draft.value.notes !== me.value?.notes);

async function saveProfile() {
	if (!hasChanges.value || saving.value) return;
	saving.value = true;
	try {
		const saved = await $userPQ.updateCurrentUserProfile({ name: draft.value.name, notes: draft.value.notes });
		editing.value = false;

		if (saved?.awaitingApproval) {
			$swal.fire({
				icon: 'info',
				title: 'Saved on this device',
				text: 'The change waits for the device owner to approve your account, and goes out then; until then your other devices and contacts see the previous profile.',
			});
		} else if (saved?.pending) {
			$swal.fire({
				icon: 'info',
				title: 'Saved on this device',
				text: 'The server is out of reach. The change is kept here and goes out when the connection is back; until then your other devices and contacts see the previous profile.',
			});
		}
	} catch (e) {
		console.error('[account] profile save failed:', e);
		$swal.fire({
			icon: 'error',
			title: 'Profile not fully saved',
			text: `Part of the change may be kept on this device, but this went wrong: ${e?.message ?? e}`,
		});
	} finally {
		saving.value = false;
	}
}

const connectDevice = () => $mitt.emit('modal::open', { id: 'account_link_approve' });
const downloadBackup = () => $mitt.emit('modal::open', { id: 'account_backup_local' });
// A contact is added by the two-way QR handshake.
const shareContact = () => $mitt.emit('modal::open', { id: 'add_contact_handshake' });

const removeAccount = async () => {
	if (!(await $swalModal.value.open({ id: 'delete_account', data: $userPQ.currentUser }))) return;

	$router.push({ name: 'login' });
};
</script>
