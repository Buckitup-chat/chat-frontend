<template>
    <div v-if="$userPQ.currentUser">
        <ul class="nav nav-pills mb-3 justify-content-center">
            <li class="nav-item">
                <a class="nav-link _pointer" :class="{ active: activeTab === 'file' }"
                    @click="activeTab = 'file'">Backup File</a>
            </li>
            <li class="nav-item">
                <a class="nav-link _pointer" :class="{ active: activeTab === 'local' }"
                    @click="activeTab = 'local'">Local Shares</a>
            </li>
            <li class="nav-item">
                <a class="nav-link _pointer" :class="{ active: activeTab === 'lit' }" @click="activeTab = 'lit'">Online
                    Shares</a>
            </li>
        </ul>

        <div class="tab-content">
            <div v-if="activeTab === 'file'">
                <RestoreFromLocal @account="setAccount" :key="updateKey" />
            </div>
            <div v-if="activeTab === 'local'">
                <RestoreFromShares @restore="setSecret" @account="setAccount" :key="updateKey" />
            </div>
            <div v-if="activeTab === 'lit'">
                <RestoreFromLit @account="setAccount" :key="updateKey" />
            </div>
        </div>
    </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

.nav-pills {
    .nav-link {
        color: $dark;
        border-radius: 20px;
        padding: 0.5rem 1rem;
        margin: 0 0.25rem;

        &:hover {
            background-color: rgba($dark, 0.1);
        }

        &.active {
            background-color: $dark;
            color: $white;
        }
    }
}
</style>

<script setup>
import { ref, inject } from 'vue';
import RestoreFromShares from './RestoreFromShares.vue';
import RestoreFromLocal from './RestoreFromLocal.vue';
import RestoreFromLit from './RestoreFromLit.vue';

const activeTab = ref('file');
const secretText = ref();
const $userPQ = inject('$userPQ');
const $swal = inject('$swal');
const $router = inject('$router');
const updateKey = ref(0);

const setSecret = async (s) => {
    secretText.value = s;
};

const setAccount = async () => {
    updateKey.value++;
    secretText.value = null;
    $swal.fire({
        icon: 'success',
        title: 'Account restored',
        timer: 5000,
    });
    $router.replace({ name: 'account_info' });
};
</script>