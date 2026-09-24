<template>
  <div class="sync-status">
    <span class="status-dot" :class="props.state" />
    <span class="status-text">{{ LABELS[props.state] }}</span>
  </div>
</template>

<script setup lang="ts">
import type { AccountSyncState } from '@/composables/useAccountSyncStatus'

const props = defineProps<{ state: AccountSyncState }>()

const LABELS: Record<AccountSyncState, string> = {
  offline: 'Offline',
  syncing: 'Syncing',
  needs_attention: 'Needs attention',
  synced: 'Synced',
}
</script>

<style scoped>
.sync-status {
  display:global(.dark) & {
    opacity: 0.9;
  }

  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #64748b;
  white-space: nowrap;
}

.status-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background-color: #efa244;

  flex-shrink: 0;
  transition: background-color 0.3s ease;
}

.status-dot.synced {
  background-color: #22c55e;
  /* зелений — синхронізовано */
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
}

.status-dot.offline {
  background-color: #94a3b8;
}

.status-dot.needs_attention {
  background-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
}

.last-sync {
  color: #94a3b8;
  font-size: 12px;
}

/* Анімація пульсації при свіжій синхронізації (опціонально) */
.status-dot.synced {
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.2);
  }

  70% {
    box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
  }

  100% {
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
  }
}
</style>