<script setup lang="ts">
import { useTransfersStore } from '@/store/transfers.store';
import Account_Item_PQ from '@/components/Account_Item_PQ.vue'
import SyncStatus from './SyncStatus.vue'
import { ref, computed } from 'vue'
import { userPQStore } from '@/store/userPQ.store'

const emit = defineEmits<{ select: [address: string] }>()

const { selected } = defineProps({
  selected: { type: Array, default: () => [] },
})

const $userPQ = userPQStore()

const search = ref('')

// Electric-synced user cards (rows in the collection are server-confirmed,
// so there is no "locally modified, not yet synced" set anymore)
const users: any = computed(() => $userPQ.allNetworkUsers)

const usersLocal: any = computed(() => [])

const hasUsers = computed(() => users.value.length > 0)

const isSelected = (address) => {
  return selected.findIndex((a) => a === address) > -1
}

const select = (address) => {
  emit('select', address)
}

const filtered = computed(() => {
  let list = users.value
  if ($userPQ.currentUserHash) {
    list = list.filter((u) => u.user_hash !== $userPQ.currentUserHash)
  }
  if (search.value) {
    const term = search.value.toLowerCase()
    list = list.filter((u) => u.name?.toLowerCase().includes(term))
  }
  return list
})
const $transfers = useTransfersStore();
</script>

<template>
  <div class="_users_list" :class="{ _has_users: hasUsers }">
    <div v-if="hasUsers">
      <div class="flex align-center mb-1 w-full" v-if="hasUsers">
        <SyncStatus :isSynced="usersLocal.length == 0" />
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
      <div class="_user" @click="select(user.user_hash)" v-for="user in filtered" :class="{ _selected: isSelected(user.user_hash) }">
        <Account_Item_PQ :account="user" class="w-100" />
        <!-- Screen 11: the dialog a transfer is going to is marked. -->
        <span v-if="$transfers.transferPeers.has(user.user_hash)" class="_transfer_dot" title="Transfer in progress">
          <span class="_transfer_dot_mark"></span>передача
        </span>
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

._transfer_dot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #8e2b77;
  flex-shrink: 0;
  padding-left: 6px;
}
._transfer_dot_mark {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8e2b77;
  animation: transfer-pulse 1.6s ease-in-out infinite;
}
@keyframes transfer-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
</style>
