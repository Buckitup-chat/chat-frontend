<script setup>
import { ref, watch } from 'vue';
import { localDB } from '../../utils/db/localDBv2';
import { providePGlite } from '@electric-sql/pglite-vue';
import { useLoader } from '@/composables/useLoader';
import { userPQStore } from '@/store/userPQ.store';

const $loader = useLoader();
const $userPQ = userPQStore();
const db = ref();

if (!$userPQ.isInitialized) {
  $loader.show();
}

localDB.init().then(() => { db.value = localDB.db; });

watch(() => $userPQ.isInitialized, (val) => {
  if (val) {
    $loader.hide();
    console.time('post-init wait');
  }
});

providePGlite(db);

</script>

<template>
  <slot v-if="db" />
</template>
