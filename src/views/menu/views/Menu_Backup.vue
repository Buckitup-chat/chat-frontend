<template>
    <!-- TODO: PQ - Backup features need PQ implementation (Coming Soon) -->
    <router-link :to="{ name: 'account_backups' }" custom v-slot="{ isActive, navigate }">
        <div class="_sub_menu_btn" :class="{ '_active': isActive }" @click="select(navigate)">
            <div class="_i_block">
                <i class="_icon_backups" :class="{ '_active': isActive }"></i>
            </div>                    
            <div>                        
                Backup Center
            </div>
        </div>
    </router-link>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

</style>

<script setup>
import { useMenu } from '@/composables/useMenu';


import { inject } from 'vue';
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const select = (navigate) => {
    closeMenu();
    navigate()
}

</script>