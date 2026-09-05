<template>
  <!-- What actually changed since the checkpoint — the changes themselves,
       not their names. Edits show the word-level diff the same way the edit
       history does; every row jumps to its message in the feed. -->
  <div class="cd-modal" @click.self="emit('close')">
    <div class="cd-card">
      <div class="cd-head">
        <div>
          <div class="cd-title">Since the checkpoint</div>
          <div class="cd-sub">{{ fmtWhen }} · {{ changes.length }} {{ changes.length === 1 ? 'change' : 'changes' }}</div>
        </div>
        <button type="button" class="cd-close" @click="emit('close')" title="Close">✕</button>
      </div>

      <div v-for="c in changes" :key="c.messageId + c.type" class="cd-change" role="button"
        @click="emit('jump', c.messageId)">
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

      <p class="cd-fine">The checkpoint fixed what this device had verified locally at signing time; it does not claim no other events existed elsewhere.</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { diffWords } from '@/lib/data/textDiff';

const props = defineProps({
  createdAt: { type: Number, required: true },
  /** Hydrated changes: [{ type, messageId, oldText?, newText?, authorName? }] */
  changes: { type: Array, required: true },
});
const emit = defineEmits(['close', 'jump']);

const fmtWhen = computed(() => new Date(props.createdAt * 1000).toLocaleString());

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
.cd-modal {
  position: fixed;
  inset: 0;
  z-index: 1070;
  background: rgba(23, 22, 26, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.cd-card {
  background: #fff;
  border-radius: 20px;
  padding: 16px;
  width: min(92vw, 440px);
  max-height: 86vh;
  overflow-y: auto;
}
.cd-head { display: flex; align-items: flex-start; justify-content: space-between; }
.cd-title { font-size: 14px; font-weight: 600; color: #17161a; }
.cd-sub { font-size: 11px; color: #7a7a7a; }
.cd-close { border: none; background: none; color: #7a7a7a; font-size: 16px; }
.cd-change { margin-top: 12px; padding: 8px 10px; border-radius: 12px; background: #f7f6f8; cursor: pointer; }
.cd-change:hover { background: #f1eef3; }
.cd-meta { display: flex; align-items: center; gap: 8px; }
.cd-tag {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 999px;
  color: #fff;
  background: #8f889b;
  &._message_added { background: #2e7d32; }
  &._message_edited { background: #8e2b77; }
  &._message_deleted { background: #b3261e; }
  &._message_restored { background: #1565c0; }
}
.cd-author { font-size: 11px; color: #7a7a7a; }
.cd-text { margin-top: 4px; font-size: 13px; line-height: 1.45; color: #17161a; white-space: pre-wrap; word-break: break-word; }
.cd-text._old { color: #8f889b; }
.cd-added { background: rgba(142, 43, 119, .14); color: #8e2b77; border-radius: 3px; padding: 0 1px; }
.cd-removed { background: rgba(143, 136, 155, .18); color: #8f889b; border-radius: 3px; padding: 0 1px; }
.cd-fine { margin: 14px 0 0; font-size: 10px; line-height: 1.4; color: #9a9c9d; }
</style>
