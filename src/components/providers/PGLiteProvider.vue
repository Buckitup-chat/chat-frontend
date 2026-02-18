<script setup>
import { localDB } from '../../utils/db/localDB';
import { providePGlite } from '@electric-sql/pglite-vue';
import { onMounted, inject } from 'vue';

const providedDB = await localDB.init()

providePGlite(providedDB)

onMounted(async () => {
  const $encryptionManager = inject('$encryptionManager');
  const vaults = await $encryptionManager.getVaults()

  const vaultsForSync = vaults.map(vault => {
    return { name: vault.name, publicKey: vault.publicKey }
  })

  console.log("Vaults for sync", vaultsForSync)

  vaultsForSync.forEach(async (vault) => {
    await providedDB.addLocalUser(vault.name, vault.publicKey)
  });
});

</script>

<template>
  <slot></slot>
</template>
