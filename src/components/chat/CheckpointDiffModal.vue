<template>
  <!-- The checkpoint comparison over the dialog: CheckpointDiffBody in a modal. -->
  <div class="cd-modal" @click.self="emit('close')">
    <div class="cd-card">
      <div class="cd-head">
        <div>
          <div class="cd-title">Since the checkpoint</div>
          <div class="cd-sub">{{ fmtWhen }} · {{ subLine }}</div>
        </div>
        <button type="button" class="cd-close" @click="emit('close')" title="Close"><i class="_icon_times"></i></button>
      </div>
      <CheckpointDiffBody :changes="changes" :future-added="futureAdded" @jump="(id) => emit('jump', id)" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import CheckpointDiffBody from './CheckpointDiffBody.vue';
import { checkpointChangesLine, checkpointTime, countCheckpointChanges } from '@/lib/data/checkpointSummary';

const props = defineProps({
  createdAt: { type: Number, required: true },
  /** Hydrated PAST changes only: revisions of what the checkpoint attested. */
  changes: { type: Array, required: true },
  /** New messages ahead of the pointer, collapsed: { count, firstMessageId }. */
  futureAdded: { type: Object, default: null },
});
const emit = defineEmits(['close', 'jump']);

const fmtWhen = computed(() => checkpointTime(props.createdAt));
const subLine = computed(() => checkpointChangesLine(countCheckpointChanges(props.changes, props.futureAdded)));
</script>

<style lang="scss" scoped>
.cd-modal {
  position: fixed;
  inset: 0;
  z-index: 1070;
  background: rgba(23, 22, 26, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}
.cd-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--color-bg);
  border-radius: var(--radius-sheet);
  box-shadow: var(--shadow-lg);
  padding: var(--space-4);
  width: min(92vw, 440px);
  max-height: 86vh;
  overflow-y: auto;
}
.cd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.cd-title { font-size: var(--text-base); line-height: var(--leading-base); font-weight: var(--weight-semibold); color: var(--color-text); }
.cd-sub { font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--color-text-muted); }
.cd-close {
  flex-shrink: 0;
  display: flex;
  padding: var(--space-1);
  border: none;
  background: none;
  cursor: pointer;

  i { width: 20px; height: 20px; background-color: var(--color-text-muted); }
  &:hover i { background-color: var(--color-text); }
}
</style>
