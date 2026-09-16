<template>
  <!-- Board screen 06: versions top-down, the current one marked by the left
       bar, differences highlighted inside the text — no separate compare
       mode. Reactions belong to the exact version they were made on. -->
  <div class="eh-modal" @click.self="emit('close')">
    <div class="eh-card">
      <div class="eh-head">
        <div>
          <div class="eh-title">Edit history</div>
          <div class="eh-sub">{{ versionsTotal }} {{ versionsTotal === 1 ? 'version' : 'versions' }} · signature-verified</div>
        </div>
        <button type="button" class="eh-close" @click="emit('close')" title="Close">✕</button>
      </div>

      <!-- current version, marked by the bar -->
      <div class="eh-version _current">
        <div class="eh-bar"></div>
        <div class="eh-body">
          <div class="eh-when">Current version<template v-if="currentTime"> · {{ currentTime }}</template></div>
          <div class="eh-text">
            <template v-for="(p, i) in currentDiff" :key="i"><mark v-if="p.kind === 'added'" class="eh-added">{{ p.text }}</mark><template v-else-if="p.kind === 'same'">{{ p.text }}</template></template>
          </div>
          <div v-if="reactionsFor(currentSignHash).length" class="eh-reactions">
            {{ reactionsFor(currentSignHash).join(' ') }}
          </div>
        </div>
      </div>

      <template v-if="history.length">
        <div class="eh-past-title">Past versions · {{ history.length }}</div>
        <div v-for="(v, i) in history" :key="v.signHash" class="eh-version">
          <div class="eh-bar _past"></div>
          <div class="eh-body">
            <div class="eh-when">
              <span class="eh-tag">historical version {{ history.length - i }}</span>
              <template v-if="v.time"> · {{ v.time }}</template>
            </div>
            <div class="eh-text _past">
              <template v-for="(p, j) in v.diff" :key="j"><del v-if="p.kind === 'removed'" class="eh-removed">{{ p.text }}</del><template v-else-if="p.kind === 'same'">{{ p.text }}</template></template>
            </div>
            <div v-if="reactionsFor(v.signHash).length" class="eh-reactions">
              {{ reactionsFor(v.signHash).join(' ') }} — reaction stays with this version
            </div>
            <div v-if="!v.verified" class="eh-unverified">unverifiable revision</div>
          </div>
        </div>
      </template>
      <div v-else class="eh-past-title">No earlier versions synced yet</div>

      <p class="eh-fine">Reactions and read confirmations belong to a specific version. After an edit, confirmation has to be given again.</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { diffWords } from '@/lib/data/textDiff';

const props = defineProps({
  /** Current text of the tip. */
  currentText: { type: String, required: true },
  currentSignHash: { type: String, default: '' },
  currentTime: { type: String, default: '' },
  /** Newest-first: [{ signHash, text, time, verified, deletedFlag }] */
  history: { type: Array, default: () => [] },
  /** message_sign_hash -> array of emoji */
  reactionsByVersion: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['close']);

const versionsTotal = computed(() => props.history.length + 1);

// Each version is diffed against ITS predecessor: the current shows what its
// edit added, a past version shows what the next edit removed from it.
const currentDiff = computed(() =>
  diffWords(props.history[0]?.text ?? props.currentText, props.currentText));
const history = computed(() =>
  props.history.map((v, i) => ({
    ...v,
    diff: diffWords(v.text ?? '', i === 0 ? props.currentText : props.history[i - 1]?.text ?? v.text ?? ''),
  })),
);

const reactionsFor = (signHash) => props.reactionsByVersion[signHash] ?? [];
</script>

<style lang="scss" scoped>
.eh-modal {
  position: fixed;
  inset: 0;
  z-index: 1070;
  background: rgba(23, 22, 26, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.eh-card {
  background: #fff;
  border-radius: 20px;
  padding: 16px;
  width: min(92vw, 440px);
  max-height: 86vh;
  overflow-y: auto;
}
.eh-head { display: flex; align-items: flex-start; justify-content: space-between; }
.eh-title { font-size: 14px; font-weight: 600; color: #17161a; }
.eh-sub { font-size: 11px; color: #7a7a7a; }
.eh-close { border: none; background: none; color: #7a7a7a; font-size: 16px; }
.eh-version { display: flex; gap: 10px; margin-top: 12px; }
.eh-bar { width: 3px; border-radius: 999px; background: #8e2b77; flex-shrink: 0; }
.eh-bar._past { background: #e0dde4; }
.eh-body { min-width: 0; flex: 1; }
.eh-when { font-size: 11px; color: #7a7a7a; }
.eh-tag { font-size: 9px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: #8f889b; }
.eh-text { margin-top: 3px; font-size: 13px; line-height: 1.45; color: #17161a; white-space: pre-wrap; word-break: break-word; }
.eh-text._past { color: #8f889b; }
/* the change is highlighted inside the text — no compare mode */
.eh-added { background: rgba(142, 43, 119, .14); color: #8e2b77; border-radius: 3px; padding: 0 1px; }
.eh-removed { background: rgba(143, 136, 155, .18); color: #8f889b; border-radius: 3px; padding: 0 1px; }
.eh-reactions { margin-top: 4px; font-size: 11px; color: #55525c; }
.eh-unverified { margin-top: 3px; font-size: 10px; font-style: italic; color: #dc3545; }
.eh-past-title { margin-top: 14px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #8f889b; }
.eh-fine { margin: 14px 0 0; font-size: 10px; line-height: 1.4; color: #9a9c9d; }
</style>
