<script setup>
import { localDB } from '../../utils/db/localDBv2';
import { providePGlite } from '@electric-sql/pglite-vue';
// import { onMounted, inject } from 'vue';

const providedDB = await localDB.init()

providePGlite(providedDB)

</script>

<template>
  <slot></slot>
</template>
