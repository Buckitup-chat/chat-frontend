<template>
  <!-- Screen 10: the header holds the aggregate and "Start all"; the list is
       cut off with an "N more" line so the panel never covers the chat. While
       transfers run the panel cannot be closed — only collapsed into the
       one-line counter; it disappears by itself once the queue is empty. -->
  <div v-if="$transfers.items.length" class="transfer-panel">
    <button v-if="$transfers.collapsed" type="button" class="transfer-collapsed"
      @click="$transfers.toggleCollapsed()">
      <span class="transfer-collapsed-count">{{ $transfers.stats.count }}</span>
      transfers · {{ $transfers.stats.percent }}%
    </button>

    <template v-else>
      <div class="transfer-head">
        <div class="transfer-head-text">
          <div class="transfer-title">Transfers · {{ $transfers.stats.count }} files</div>
          <div class="transfer-sub">
            {{ $transfers.stats.active }} running · {{ $transfers.stats.waiting }} waiting · keep this tab open
          </div>
        </div>
        <span class="transfer-percent">{{ $transfers.stats.percent }}%</span>
        <button v-if="$transfers.stats.waiting === 0 && hasStartable" type="button"
          class="transfer-btn" @click="$transfers.startAll()">Start all</button>
        <button type="button" class="transfer-fold" title="Collapse"
          @click="$transfers.toggleCollapsed()">▾</button>
      </div>

      <div class="transfer-list">
        <div v-for="(it, i) in visibleItems" :key="it.id" class="transfer-row"
          :class="{ '_active': it.status === 'active', '_paused': it.status === 'paused', '_error': it.status === 'error', '_foreign': isForeign(it) }"
          draggable="true"
          @dragstart="dragFrom = i" @dragover.prevent @drop.prevent="onDrop(i)">
          <!-- Board: one geometry for every state — handle, name, bar,
               caption, action, quiet cancel. Colour lives in the caption and
               the bar, never in the button. -->
          <span class="transfer-handle" title="Drag to reorder">⋮⋮</span>
          <div class="transfer-body">
            <div class="transfer-name">
              <span v-if="isForeign(it)" class="transfer-elsewhere" title="Uploading to another dialog">↗</span>{{ it.name }}
            </div>
            <div class="transfer-bar">
              <div class="transfer-bar-fill" :style="{ width: percentOf(it) + '%' }"></div>
            </div>
            <div class="transfer-caption">{{ captionOf(it) }}</div>
          </div>
          <button v-if="actionOf(it)" type="button" class="transfer-btn"
            @click="applyAction(it)">{{ actionOf(it) }}</button>
          <button v-if="it.status !== 'done'" type="button" class="transfer-cancel" title="Cancel this file"
            @click="$transfers.cancel(it.id)">✕</button>
        </div>
        <div v-if="hiddenCount" class="transfer-more" role="button" @click="expanded = !expanded">
          {{ expanded ? 'Collapse the list' : `${hiddenCount} more files` }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useTransfersStore } from '@/store/transfers.store';

const props = defineProps({
  /** Peer of the dialog the panel is shown in; rows going elsewhere dim. */
  currentPeer: { type: String, default: '' },
});

const $transfers = useTransfersStore();
const isForeign = (it) => !!props.currentPeer && it.peerHash && it.peerHash !== props.currentPeer;

const MAX_ROWS = 4;
const expanded = ref(false);
const visibleItems = computed(() =>
  expanded.value ? $transfers.items : $transfers.items.slice(0, MAX_ROWS));
const hiddenCount = computed(() => Math.max(0, $transfers.items.length - MAX_ROWS));
const hasStartable = computed(() =>
  $transfers.items.some((it) => it.status === 'paused' || it.status === 'error'));

const dragFrom = ref(null);
const onDrop = (toVisibleIndex) => {
  if (dragFrom.value === null) return;
  // Visible indexes equal real indexes while the list is truncated from the top.
  $transfers.reorder(dragFrom.value, toVisibleIndex);
  dragFrom.value = null;
};

const percentOf = (it) => (it.total ? Math.round((it.done / it.total) * 100) : 0);

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtSpeed = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);

// The board's five states, worded like the board words them.
const captionOf = (it) => {
  switch (it.status) {
    case 'active':
      return `${percentOf(it)}% · chunk ${it.done} of ${it.total}` + (it.speed ? ` · ${fmtSpeed(it.speed)}` : '');
    case 'paused':
      return `Paused · ${percentOf(it)}%` + (it.done ? ` · chunk ${it.done} of ${it.total}` : '');
    case 'waiting':
      return `Waiting · ${fmtSize(it.size)}`;
    case 'error':
      return 'Interrupted — will retry on Start';
    case 'done':
      return 'Sent';
    default:
      return '';
  }
};

const actionOf = (it) => ({ active: 'Pause', paused: 'Resume', error: 'Retry', waiting: null, done: null }[it.status]);
const applyAction = (it) => {
  if (it.status === 'active') $transfers.pause(it.id);
  else $transfers.start(it.id);
};
</script>

<style lang="scss" scoped>
.transfer-panel {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 2px 12px rgba(23, 22, 26, .12);
  margin-bottom: 6px;
  overflow: hidden;
}
.transfer-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: none;
  padding: 8px 12px;
  font-size: 12px;
  color: #17161a;
}
.transfer-collapsed-count {
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
.transfer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 8px;
}
.transfer-head-text { flex: 1; min-width: 0; }
.transfer-title { font-size: 13px; font-weight: 600; color: #17161a; }
.transfer-sub { font-size: 11px; color: #7a7a7a; }
.transfer-percent { font-size: 13px; font-weight: 600; color: #8e2b77; }
.transfer-fold { border: none; background: none; color: #7a7a7a; font-size: 14px; }
.transfer-list {
  /* the cut-off line, not the height, is what bounds the panel — but a
     hard ceiling keeps an expanded list from covering the chat either */
  max-height: 260px;
  overflow-y: auto;
}
.transfer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
}
.transfer-row._active { background: #f9edf6; }
/* rows bound for another dialog: visibly not this conversation's traffic */
.transfer-row._foreign { opacity: .55; }
.transfer-row._foreign .transfer-bar-fill { background: #9a9c9d; }
.transfer-elsewhere { color: #8e2b77; margin-right: 4px; font-size: 11px; }
.transfer-handle { color: #c2c2c6; cursor: grab; font-size: 12px; letter-spacing: -2px; }
.transfer-body { flex: 1; min-width: 0; }
.transfer-name {
  font-size: 12px;
  font-weight: 500;
  color: #17161a;
  overflow: hidden;
  text-overflow: ellipsis; /* board: the END of the name is cut, the start reads */
  white-space: nowrap;
}
.transfer-bar {
  height: 3px;
  border-radius: 999px;
  background: #e6e6ea;
  overflow: hidden;
  margin: 3px 0 2px;
}
.transfer-bar-fill { height: 100%; background: #8e2b77; }
.transfer-row._paused .transfer-bar-fill { background: #c8bcd4; }
.transfer-row._error .transfer-bar-fill { background: #dc3545; }
.transfer-caption { font-size: 10px; color: #7a7a7a; }
.transfer-row._paused .transfer-caption { color: #8e2b77; }
.transfer-row._error .transfer-caption { color: #dc3545; }
/* the action stays neutral; colour lives in caption and bar (board note) */
.transfer-btn {
  border: 1px solid #8e2b77;
  background: #fff;
  color: #8e2b77;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
/* the quiet cross — deliberately lighter than the action */
.transfer-cancel { border: none; background: none; color: #c2c2c6; font-size: 13px; padding: 2px 4px; }
.transfer-cancel:hover { color: #dc3545; }
.transfer-more {
  padding: 6px 12px 8px;
  font-size: 11px;
  color: #8e2b77;
  cursor: pointer;
}
</style>
