<script setup lang="ts">
import Account_Item_PQ from '@/components/Account_Item_PQ.vue'
import SyncStatus from './SyncStatus.vue'
import { ref, computed } from 'vue'
import { userPQStore } from '@/store/userPQ.store'
import { queueStatus } from '@/utils/db/tanstack/userQueue'

const emit = defineEmits<{ select: [address: string] }>()

const props = withDefaults(defineProps<{ selected?: string[] }>(), {
  selected: () => [],
})

const $userPQ = userPQStore()

const search = ref('')

const users = computed(() => $userPQ.allNetworkUsers);

const hasUsers = computed(() => users.value.length > 0)

const isSynced = computed(() => (
  queueStatus.value.pending === 0 &&
  queueStatus.value.awaitingRemote === 0 &&
  queueStatus.value.quarantined === 0
))

const isSelected = (address: string) => {
  return props.selected.findIndex((a) => a === address) > -1
}

const select = (address: string) => {
  emit('select', address)
}

const filtered = computed(() => {
  let list = users.value
  if ($userPQ.currentUserHash) {
    list = list.filter((u) => u.user_hash !== $userPQ.currentUserHash)
  }
  if (search.value) {
    const term = search.value.toLowerCase()
    list = list.filter((u) =>
      u.name?.toLowerCase().includes(term) ||
      u.user_hash?.slice(2, 8).toLowerCase().includes(term)
    )
  }
  return list
})
</script>

<template>
  <div class="_users_list" :class="{ _has_users: hasUsers }">
    <div v-if="hasUsers">
      <div class="flex align-center mb-1 w-full">
        <SyncStatus :isSynced="isSynced" />
      </div>

      <div class="_search mb-1">
        <div class="_input_search">
          <div class="_icon_search"></div>
          <input class="" type="text" v-model="search" autocomplete="off" placeholder="Search..." />

          <div class="_icon_times" v-if="search" @click="search = ''"></div>
        </div>
      </div>
    </div>

    <div class="_list">
      <div class="_user" @click="select(user.user_hash)" v-for="user in filtered" :key="user.user_hash" :class="{ _selected: isSelected(user.user_hash) }">
        <Account_Item_PQ :account="user" class="w-100" />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._users_list {
  display: flex;
  flex-direction: column;
  overflow: hidden;

  &._has_users {
    flex-grow: 1;
    height: calc(100dvh - 3rem);
  }

  ._list {
    flex-grow: 1;
    overflow-y: auto;

    ._user {
      display: flex;
      align-items: center;
      padding: 0.5rem;
      width: 100%;
      cursor: pointer;
      border-radius: $blockRadiusSm;

      &:hover {
        background-color: lighten($black, 90%);
      }

      &._selected {
        background-color: lighten($black, 85%);
      }
    }
  }
}
</style>
