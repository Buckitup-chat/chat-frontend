<template>
	<span class="cb-ini" :class="{ small, muted }" :style="avatarTone(hash)">{{ initials(name) }}</span>
</template>

<script setup>
import { avatarTone, initials } from './backupFlow';

defineProps({
	name: { type: String, default: '' },
	hash: { type: String, default: '' },
	small: { type: Boolean, default: false },
	muted: { type: Boolean, default: false },
});
</script>

<style lang="scss" scoped>
.cb-ini {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	border-radius: 50%;
	font-weight: 600;
	font-size: 12px;
	&.small {
		width: 26px;
		height: 26px;
		font-size: 11px;
		border: 2px solid #f8f9fa;
	}
	&.muted {
		opacity: 0.6;
	}
}
</style>
