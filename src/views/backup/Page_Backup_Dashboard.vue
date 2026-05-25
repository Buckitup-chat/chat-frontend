<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header>
			<div class="fw-bold fs-5 py-1">Backup Center</div>
		</template>
		
		<template #content>
			<div class="_full_width_block">
				<ul class="nav nav-tabs mb-3">
					<li class="nav-item">
						<a class="nav-link _pointer" :class="{ active: activeTab === 'backups' }" @click="activeTab = 'backups'">My backups</a>
					</li>
					<li class="nav-item">
						<a class="nav-link _pointer" :class="{ active: activeTab === 'shares' }" @click="activeTab = 'shares'">My shares</a>
					</li>
					<li class="nav-item">
						<a class="nav-link _pointer" :class="{ active: activeTab === 'export' }" @click="activeTab = 'export'">Export local</a>
					</li>
					<li class="nav-item">
						<a class="nav-link _pointer" :class="{ active: activeTab === 'restore' }" @click="activeTab = 'restore'">Restore secret</a>
					</li>
				</ul>

				<div class="tab-content">
					<div v-if="activeTab === 'backups'">
						<Page_Backup_List />
					</div>
					<div v-if="activeTab === 'shares'">
						<Page_Backup_Shares />
					</div>
					<div v-if="activeTab === 'export'">
						<Page_Backup_ExportLocal />
					</div>
					<div v-if="activeTab === 'restore'">
						<Page_Backup_Restore />
					</div>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._full_width_block {
	width: 100%;
}

.nav-tabs {
    .nav-link {
        color: $dark;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 0.5rem 1rem;
        
        &:hover {
            border-color: transparent;
            color: $primary;
        }
        
        &.active {
            font-weight: bold;
            border-bottom-color: $dark;
            color: $dark;
            background-color: transparent;
        }
    }
}
</style>

<script setup>
import { ref, inject } from 'vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import Page_Backup_List from './Page_Backup_List.vue';
import Page_Backup_Shares from './Page_Backup_Shares.vue';
import Page_Backup_ExportLocal from './Page_Backup_ExportLocal.vue';
import Page_Backup_Restore from './Page_Backup_Restore.vue';

const $userPQ = inject('$userPQ');
const activeTab = ref('backups');
</script>