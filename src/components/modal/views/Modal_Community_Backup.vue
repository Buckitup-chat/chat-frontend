<template>
	<div class="cb">
		<component :is="SCREENS[screen]" :key="screen" />
	</div>
</template>

<script setup>
// The community backup's setup and progress (docs/design-recovery-backup.md),
// one modal with a stack of screens: Guardians → (Advanced → Nodes / Add node
// / Fee) → Alerts (→ Telegram) → Review → Progress → Done. The draft lives
// here, so closing the modal drops an unfinished setup; a started run lives in
// the store and survives it.
import { computed, inject, onMounted, provide, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { DRAFT, NAV, createBackupDraft } from '@/components/recovery/backup/backupFlow';
import Screen_Guardians from '@/components/recovery/backup/Screen_Guardians.vue';
import Screen_Advanced from '@/components/recovery/backup/Screen_Advanced.vue';
import Screen_Nodes from '@/components/recovery/backup/Screen_Nodes.vue';
import Screen_AddNode from '@/components/recovery/backup/Screen_AddNode.vue';
import Screen_Fee from '@/components/recovery/backup/Screen_Fee.vue';
import Screen_Alerts from '@/components/recovery/backup/Screen_Alerts.vue';
import Screen_Telegram from '@/components/recovery/backup/Screen_Telegram.vue';
import Screen_Review from '@/components/recovery/backup/Screen_Review.vue';
import Screen_Progress from '@/components/recovery/backup/Screen_Progress.vue';
import Screen_Done from '@/components/recovery/backup/Screen_Done.vue';

const SCREENS = {
	guardians: Screen_Guardians,
	advanced: Screen_Advanced,
	nodes: Screen_Nodes,
	addNode: Screen_AddNode,
	fee: Screen_Fee,
	alerts: Screen_Alerts,
	telegram: Screen_Telegram,
	review: Screen_Review,
	progress: Screen_Progress,
	done: Screen_Done,
};

const props = defineProps({ inputData: { type: Object, default: () => ({}) } });
const $mitt = inject('$mitt');
const store = useRecoveryBackupStore();
// Opened with `reshare` — from the finale of a recovery — it makes the next version of the backup, suggesting `keep`.
const draft = createBackupDraft(store, { reshare: !!props.inputData?.reshare, keep: Array.isArray(props.inputData?.keep) ? props.inputData.keep : null });

const first = SCREENS[props.inputData?.start] ? props.inputData.start : 'guardians';
const stack = ref([first]);
const screen = computed(() => stack.value[stack.value.length - 1]);

const refreshNodes = async () => {
	draft.state.nodesLoading = true;
	try {
		await store.refreshNodes();
	} catch (e) {
		console.warn('[recovery] nodes could not be listed:', e);
	} finally {
		draft.state.nodesLoading = false;
	}
};

const close = () => $mitt.emit('modal::close');
const nav = {
	screen,
	go: (s) => stack.value.push(s),
	back: () => (stack.value.length > 1 ? stack.value.pop() : close()),
	replace: (s) => stack.value.splice(stack.value.length - 1, 1, s),
	reset: (s) => (stack.value = [s]),
	close,
	refreshNodes,
};
provide(DRAFT, draft);
provide(NAV, nav);

onMounted(() => {
	if (!store.loaded) store.load().catch((e) => console.warn('[recovery] backup could not be read:', e));
	if (first === 'guardians') refreshNodes();
});
</script>

<style lang="scss">
@import '@/scss/variables.scss';
@import '@/components/recovery/backup/tokens';

// Shared by every screen of the flow (design: white modal, grey blocks
// #f2f2f2, the picked row #F7E0F7 with a $primary border).
.cb {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 4px;
	font-size: 14px;

	@include cb-tokens;

	.cb-head {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.cb-steps {
		display: flex;
		gap: 4px;
		span {
			flex: 1;
			height: 3px;
			border-radius: 2px;
			background: $light_grey2;
			&.on {
				background: $primary;
			}
		}
	}
	.cb-step-label {
		font-weight: 500;
		font-size: 12px;
		color: $grey_dark;
	}
	.cb-title {
		font-weight: 700;
		font-size: 17px;
		line-height: 1.25;
	}
	.cb-icon-btn {
		border: 0;
		background: transparent;
		padding: 2px;
		line-height: 0;
		span {
			display: inline-block;
			width: 1.1rem;
			height: 1.1rem;
		}
	}
	.cb-block {
		background: #f2f2f2;
		border-radius: 14px;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.cb-headline {
		font-weight: 700;
		font-size: 20px;
		line-height: 1.25;
	}
	.cb-section {
		font-weight: 600;
		font-size: 13px;
		color: #333;
	}
	.cb-row {
		&.pickable {
			cursor: pointer;
			user-select: none;
			&:hover {
				background: #f5f5f5;
			}
		}
		&.picked,
		&.picked:hover {
			background: #f7e0f7;
		}
	}
	.cb-check {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 50%;
		border: 1.5px solid #c9c9cc;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		&.on {
			border: 0;
			background: $primary;
		}
		&.none {
			border: 0;
		}
	}
	.cb-tile {
		background: #f2f2f2;
		border: 1px solid transparent;
		border-radius: 16px;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		&.pickable {
			cursor: pointer;
		}
		&.picked {
			background: #f8f8f8;
			border-color: $primary;
		}
		&.off {
			opacity: 0.55;
			cursor: default;
		}
		.cb-tile-head {
			display: flex;
			gap: 12px;
			align-items: center;
		}
		.cb-tile-title {
			font-weight: 700;
			font-size: 15px;
		}
		.cb-tile-body {
			margin-left: 30px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
	}
	.cb-radio {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		border-radius: 50%;
		border: 1.5px solid #c9c9cc;
		&.on {
			border: 5px solid $primary;
		}
	}
	.cb-group {
		background: #f2f2f2;
		border-radius: 14px;
		padding: 4px 14px;
		display: flex;
		flex-direction: column;
		> * + * {
			border-top: 1px solid #e3e3e3;
		}
	}
	.cb-setting {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 0;
		&.link {
			cursor: pointer;
		}
	}
	.cb-divider {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11px;
		color: $grey_dark;
		&::before,
		&::after {
			content: '';
			flex: 1;
			border-top: 1px dashed #c9c9cc;
		}
	}
	.cb-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		.btn-dark:disabled {
			background: #a0a0a0;
			border-color: #a0a0a0;
			opacity: 1;
		}
	}
	.cb-link {
		border: 0;
		background: transparent;
		padding: 0;
		color: $primary;
		font-weight: 500;
		text-decoration: underline;
	}
}
</style>
