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
