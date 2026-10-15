<template>
	<span class="contact-avatar" :class="{ small, muted }">
		<img v-if="src" loading="lazy" :src="src" alt="" @error="src = null" />
		<Avatar v-else :name="hash" variant="bauhaus" />
	</span>
</template>

<script setup>
// A contact's picture, or the generated one the rest of the app shows for them.
import { ref, watch } from 'vue';
import Avatar from 'vue-boring-avatars';
import { userPQStore } from '@/store/userPQ.store';

const props = defineProps({
	hash: { type: String, required: true },
	small: { type: Boolean, default: false },
	muted: { type: Boolean, default: false },
});
const $userPQ = userPQStore();
const src = ref(null);
watch(
	() => $userPQ.contactsMap?.[props.hash]?.avatar ?? null,
	(avatar) => (src.value = avatar),
	{ immediate: true },
);
</script>

<style lang="scss" scoped>
.contact-avatar {
	display: inline-flex;
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	border-radius: 50%;
	overflow: hidden;
	&.small {
		width: 26px;
		height: 26px;
		border: 2px solid #f8f9fa;
	}
	&.muted {
		opacity: 0.6;
	}
	img,
	:deep(svg) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
}
</style>
