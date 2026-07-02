<template>
	<div class="d-flex justify-content-center align-items-center mb-2" v-if="!isOnline">
		<div class="_icon_wifi bg-danger"></div>
		<div class="small text-secondary ms-2">Internet connection required</div>
	</div>
</template>

<script setup>
import { userPQStore } from '@/store/userPQ.store';


import { inject, computed } from 'vue';

const $userPQ = userPQStore();
const isOnline = computed(() => $userPQ.isOnline);
</script>
