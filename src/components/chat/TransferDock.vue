<template>
  <!-- Screen 11: outside the dialog the queue folds into one line that sits
       over the shell without covering the list; the same tap expands it. It
       is not closable — it leaves when the queue empties. -->
  <div v-if="$transfers.items.length" class="transfer-dock">
    <TransferPanel v-if="expanded" />
    <button v-else type="button" class="transfer-dock-line" @click="expanded = true">
      <span class="transfer-dock-count">{{ $transfers.stats.count }}</span>
      <span class="transfer-dock-text">
        {{ dialogCount }} {{ dialogCount === 1 ? 'dialog' : 'dialogs' }}
        · {{ $transfers.stats.percent }}% · keep this tab open
      </span>
    </button>
    <button v-if="expanded" type="button" class="transfer-dock-fold" @click="expanded = false">fold</button>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useTransfersStore } from '@/store/transfers.store';
import TransferPanel from '@/components/chat/TransferPanel.vue';

const $transfers = useTransfersStore();
const expanded = ref(false);
const dialogCount = computed(() => $transfers.transferPeers.size);
</script>

<style lang="scss" scoped>
.transfer-dock {
  position: sticky;
  bottom: 8px;
  margin: 8px;
  z-index: 20;
}
.transfer-dock-line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 2px 12px rgba(23, 22, 26, .16);
  padding: 8px 12px;
  font-size: 12px;
  color: #17161a;
}
.transfer-dock-count {
  background: #8e2b77;
  color: #fff;
  border-radius: 999px;
  min-width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
}
.transfer-dock-text { color: #55525c; }
.transfer-dock-fold {
  border: none;
  background: none;
  color: #8e2b77;
  font-size: 11px;
  padding: 4px 12px 0;
}
</style>
