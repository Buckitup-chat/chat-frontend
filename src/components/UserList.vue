<script setup lang="ts">
import { useTransfersStore } from '@/store/transfers.store';
import Account_Item_PQ from '@/components/Account_Item_PQ.vue'
import SyncStatus from './SyncStatus.vue'
import { ref, computed, onMounted, onBeforeUnmount, watch, inject } from 'vue'
import { userPQStore } from '@/store/userPQ.store'
import { useDialogsStore } from '@/store/dialogs.store'

const emit = defineEmits<{ select: [address: string, opts?: { checkpoint?: boolean | string }] }>()

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
const $dialogs = useDialogsStore();

// Checkpoint alerts (see dialogs.store): the list scans the dialogs this
// account has confirmed a state in and marks the ones that moved since.
//
// The list holds no dialog subscription of its own, so there is nothing to
// react to — the scan is re-run at the moments the answer can have changed:
// coming back from a dialog, returning to the tab, and while the list is on
// screen. The store collapses overlapping runs into one.
const scanAlerts = () => {
  const peers = filtered.value.map((u) => u.user_hash).filter(Boolean)
  if (peers.length) $dialogs.scanCheckpointAlerts(peers)
}

const $route = inject('$route', null)
let rescanTimer = null
const onVisible = () => { if (document.visibilityState === 'visible') scanAlerts() }

onMounted(() => {
  scanAlerts()
  document.addEventListener('visibilitychange', onVisible)
  // A dialog open in another tab or on another device moves while this list
  // is shown; nothing here observes that, so the list refreshes on a slow
  // beat rather than pretending to be live.
  rescanTimer = setInterval(scanAlerts, 30000)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisible)
  clearInterval(rescanTimer)
})
watch(() => filtered.value.length, scanAlerts)
watch(() => $route?.params?.address, (now, before) => { if (before && !now) scanAlerts() })
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
        <!-- The dialog moved since the checkpoint this account signed in it.
             Tapping it opens the dialog on the checkpoint comparison. -->
        <span v-if="$dialogs.alertingPeers.has(user.user_hash)" class="_checkpoint_dot"
          role="button" title="Изменилось с момента вашей отметки — открыть сравнение"
          @click.stop="emit('select', user.user_hash, { checkpoint: $dialogs.checkpointAlerts.get(user.user_hash)?.messageId || true })"></span>
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

._checkpoint_dot {
  cursor: pointer;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #8e2b77;
  box-shadow: 0 0 0 3px rgba(142, 43, 119, .18);
  flex-shrink: 0;
  margin-left: 8px;
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
