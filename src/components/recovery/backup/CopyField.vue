<template>
	<div class="cb-copy">
		<span class="cb-copy-text" :class="{ wrap }">{{ shown ?? value }}</span>
		<button type="button" class="btn btn-sm btn-outline-dark" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
	</div>
</template>

<script setup>
import { ref } from 'vue';
import copyToClipboard from '@/utils/copyToClipboard';

const props = defineProps({
	value: { type: String, required: true },
	/** What the field shows, when shorter than what it copies. */
	shown: { type: String, default: null },
	wrap: { type: Boolean, default: false },
});
const copied = ref(false);
const copy = async () => {
	copied.value = !!(await copyToClipboard(props.value, false));
};
</script>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

.cb-copy {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 38px;
	border: 1px solid $light_grey2;
	border-radius: 8px;
	padding: 4px 6px 4px 12px;
	background: #fff;
}
.cb-copy-text {
	flex: 1;
	font-family: ui-monospace, monospace;
	font-size: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	&.wrap {
		white-space: normal;
		word-break: break-all;
	}
}
</style>
