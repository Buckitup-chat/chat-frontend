<template>
  <!-- What actually changed since the checkpoint — the changes themselves,
       not their names. Edits show the word-level diff the same way the edit
       history does; every row jumps to its message in the feed. Shown in the
       dialog's modal and in the Checkpoints screen's panel. -->
  <div class="cd-body">
    <div v-for="c in changes" :key="c.messageId + c.type" class="cd-change" role="button" tabindex="0"
      @click="emit('jump', c.messageId)" @keydown.enter="emit('jump', c.messageId)">
      <div class="cd-meta">
        <span class="cd-tag" :class="'_' + c.type.toLowerCase()">{{ label(c.type) }}</span>
        <span v-if="c.authorName" class="cd-author">{{ c.authorName }}</span>
      </div>

      <template v-if="c.type === 'MESSAGE_EDITED'">
        <div class="cd-text _old">
          <template v-for="(p, i) in diffWords(c.oldText || '', c.newText || '')" :key="i"><del
              v-if="p.kind === 'removed'" class="cd-removed">{{ p.text }}</del><template
              v-else-if="p.kind === 'same'">{{ p.text }}</template></template>
        </div>
        <div class="cd-text">
          <template v-for="(p, i) in diffWords(c.oldText || '', c.newText || '')" :key="i"><mark
              v-if="p.kind === 'added'" class="cd-added">{{ p.text }}</mark><template
              v-else-if="p.kind === 'same'">{{ p.text }}</template></template>
        </div>
      </template>

      <div v-else-if="c.type === 'MESSAGE_ADDED'" class="cd-text">{{ c.newText || '…' }}</div>
      <div v-else-if="c.type === 'MESSAGE_DELETED'" class="cd-text _old"><del class="cd-removed">{{ c.oldText || '…' }}</del></div>
      <div v-else-if="c.type === 'MESSAGE_RESTORED'" class="cd-text">{{ c.newText || '…' }}</div>
      <div v-else class="cd-text _old">was present at the checkpoint, missing from local state now</div>
    </div>

    <!-- The dialog ahead of the pointer is unbounded — one marker, not a list. -->
    <div v-if="futureAdded && futureAdded.count" class="cd-change _future" role="button" tabindex="0"
      @click="futureAdded.firstMessageId && emit('jump', futureAdded.firstMessageId)"
      @keydown.enter="futureAdded.firstMessageId && emit('jump', futureAdded.firstMessageId)">
      <span class="cd-tag _future_tag">after</span>
      <span class="cd-text">{{ futureAdded.count }} new {{ futureAdded.count === 1 ? 'message' : 'messages' }} since the checkpoint</span>
    </div>

    <div v-if="!changes.length && !(futureAdded && futureAdded.count)" class="cd-text _old">Nothing changed.</div>

    <p class="cd-fine">A checkpoint fixes what this device had verified when you signed it. It does not prove nothing else existed elsewhere.</p>
  </div>
</template>

<script setup>
import { diffWords } from '@/lib/data/textDiff';

defineProps({
  /** Hydrated PAST changes only: revisions of what the checkpoint attested. */
  changes: { type: Array, required: true },
  /** New messages ahead of the pointer, collapsed: { count, firstMessageId }. */
  futureAdded: { type: Object, default: null },
});
const emit = defineEmits(['jump']);

const LABELS = {
  MESSAGE_ADDED: 'added',
  MESSAGE_EDITED: 'edited',
  MESSAGE_DELETED: 'deleted',
  MESSAGE_RESTORED: 'restored',
  MESSAGE_REMOVED: 'missing',
};
const label = (type) => LABELS[type] || type;
</script>

<style lang="scss" scoped>
.cd-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.cd-change {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-input);
  background: var(--color-surface);
  cursor: pointer;

  &:hover { background: var(--color-accent-tint); }
  &:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

  &._future {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--color-bg);
    border: 1px dashed var(--color-border-strong);

    .cd-text { margin: 0; }
  }
}
.cd-meta { display: flex; align-items: center; gap: var(--space-2); }
.cd-tag {
  flex-shrink: 0;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  font-weight: var(--weight-medium);
  background: var(--color-bg);
  color: var(--color-text-secondary);

  &._message_added { background: var(--color-success-bg); color: var(--color-success); }
  &._message_edited { background: var(--color-accent-tint); color: var(--color-accent-dark); }
  &._message_deleted { background: var(--color-danger-bg); color: var(--color-danger); }
  &._message_restored { background: var(--color-warning-bg); color: var(--color-warning); }
  &._future_tag { background: var(--color-surface); }
}
.cd-author { font-size: var(--text-xs); line-height: var(--leading-xs); color: var(--color-text-muted); }
.cd-text {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--leading-sm);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;

  &._old { color: var(--color-text-secondary); }
}
.cd-added { background: var(--color-accent-tint); color: var(--color-accent-dark); }
.cd-removed { color: var(--color-text-muted); }
.cd-fine {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  color: var(--color-text-muted);
}
</style>
