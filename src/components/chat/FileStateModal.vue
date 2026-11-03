<template>
  <!-- Screen 05: opens from the file row. Chunks drawn big, so "partially
       here" reads as a process, not a breakdown; one button. -->
  <div class="fs-modal" @click.self="emit('close')">
    <div class="fs-card">
      <div class="fs-head">
        <div class="fs-title">File state</div>
        <button type="button" class="fs-close" @click="emit('close')" title="Close">✕</button>
      </div>

      <div class="fs-name">{{ part.name }}</div>
      <div class="fs-meta">{{ fmtSize(part.size) }}<template v-if="from"> · from {{ from }}</template><template v-if="sentAt"> · {{ sentAt }}</template></div>

      <p v-if="refused" class="fs-note fs-refused">
        This file could not be verified: what this node holds does not match
        what its sender signed.
      </p>
      <!-- pq_files §7: a deleted file is a tombstone with no chunk list; the
           server reclaims its bytes. Nothing is "on the way" any more. -->
      <p v-else-if="deletedOnServer" class="fs-note">
        <template v-if="kept">The sender deleted this file from the server. Only this device has it now.</template>
        <template v-else>The sender deleted this file from the server.</template>
      </p>
      <template v-else-if="showsChunks">
        <div class="fs-chunks">
          <span v-for="i in availability.total" :key="i" class="fs-chunk"
            :class="{ _have: i <= availability.present }"></span>
        </div>
        <div class="fs-count">
          <span>{{ availability.present }} of {{ availability.total }} chunks here</span>
          <span class="fs-percent">{{ percent }}%</span>
        </div>
        <p class="fs-note">
          The file travels node to node. That is normal for a network without
          internet: the missing chunks arrive on their own, and a backfill
          request can speed them up.
        </p>
        <button type="button" class="fs-btn" :disabled="checking" @click="emit('refresh')">
          {{ checking ? 'Checking…' : complete || kept ? 'Download' : 'Request priority backfill' }}
        </button>
      </template>
      <p v-else-if="kept" class="fs-note">This file opens from the copy kept on this device.</p>
      <p v-else class="fs-note">The file's manifest has not reached this node yet.</p>

      <!-- Keep on this device. The switch shows what is, not what was
           tapped: it is on while the file is kept or being kept, and a keep
           that fails leaves it off with the reason underneath. -->
      <template v-if="!refused">
        <div class="form-check form-switch mt-3 mb-0">
          <input id="fs-keep" class="form-check-input" type="checkbox" role="switch"
            :checked="kept || !!keeping" :disabled="!!keeping || (!kept && !keepable)"
            @change="onKeepChange" />
          <label class="form-check-label small" for="fs-keep">Keep on this device</label>
        </div>
        <p v-if="keeping" class="fs-note">
          Keeping<template v-if="keeping.total"> · chunk {{ keeping.done }} of {{ keeping.total }}</template>…
        </p>
        <p v-else-if="keepError" class="fs-note fs-refused">{{ keepError }}</p>
        <p v-else-if="kept && messageDeleted" class="fs-note">The message was deleted. The copy kept on this device remains.</p>
        <p v-else-if="kept" class="fs-note">Kept on this device: it opens offline and stays if the sender deletes it. It is not copied to your other devices.</p>
        <button v-if="kept && !showsChunks" type="button" class="fs-btn" @click="emit('refresh')">Download</button>
      </template>

      <template v-if="log.length">
        <div class="fs-log-title">Backfill so far</div>
        <div v-for="e in log" :key="e.at + '-' + e.present" class="fs-log-row">
          <span class="fs-log-time">{{ fmtTime(e.at) }}</span>
          <span class="fs-log-text">{{ describe(e) }}</span>
        </div>
      </template>

      <p class="fs-fine">Unfinished uploads are kept for 48 hours; after that the sender has to send the file again.</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  part: { type: Object, required: true },
  availability: { type: Object, default: null },
  /** The file's manifest or chunks contradict its sender's signatures (docs/invariants.md §6a). */
  refused: { type: Boolean, default: false },
  log: { type: Array, default: () => [] },
  from: { type: String, default: '' },
  sentAt: { type: String, default: '' },
  checking: { type: Boolean, default: false },
  /** This account keeps the file on this device (keptFiles.ts). */
  kept: { type: Boolean, default: false },
  /** Progress of keeping it, in chunks, while that runs. */
  keeping: { type: Object, default: null },
  /** Why the last keep or release failed. */
  keepError: { type: String, default: '' },
  /** The message that carried the file was deleted; only the kept copy shows it. */
  messageDeleted: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'refresh', 'keep']);

const known = computed(() => !!props.availability && !props.availability.unknown);
const deletedOnServer = computed(() => known.value && props.availability.deleted);
/** The chunk view, whose button downloads; otherwise a kept file gets its own. */
const showsChunks = computed(() => known.value && !props.availability.deleted);
/** Keeping needs the signed manifest, and a deleted file has none to give. */
const keepable = computed(() => known.value && !props.availability.deleted);
const onKeepChange = (event) => {
  const want = event.target.checked;
  event.target.checked = props.kept || !!props.keeping;
  emit('keep', want);
};

const percent = computed(() =>
  props.availability?.total ? Math.round((props.availability.present / props.availability.total) * 100) : 0);
const complete = computed(() => known.value && props.availability.present >= props.availability.total);

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtTime = (unix) => {
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const describe = (e) => {
  if (e.present === 0) return 'Metadata arrived, no chunks yet';
  if (e.present >= e.total) return 'All chunks here';
  return `${e.present} of ${e.total} chunks — backfill continuing`;
};
</script>

<style lang="scss" scoped>
.fs-refused { color: #dc3545; }

.fs-modal {
  position: fixed;
  inset: 0;
  z-index: 1070;
  background: rgba(23, 22, 26, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.fs-card {
  background: #fff;
  border-radius: 20px;
  padding: 16px;
  width: min(92vw, 420px);
  max-height: 86vh;
  overflow-y: auto;
}
.fs-head { display: flex; align-items: center; justify-content: space-between; }
.fs-title { font-size: 14px; font-weight: 600; color: #17161a; }
.fs-close { border: none; background: none; color: #7a7a7a; font-size: 16px; }
.fs-name { margin-top: 8px; font-size: 13px; font-weight: 600; color: #17161a; word-break: break-all; }
.fs-meta { font-size: 11px; color: #7a7a7a; }
/* chunks drawn big — the whole point of the screen */
.fs-chunks { display: flex; gap: 4px; margin: 12px 0 6px; }
.fs-chunk { flex: 1; height: 12px; border-radius: 3px; background: #e6e6ea; }
.fs-chunk._have { background: #8e2b77; }
.fs-count { display: flex; justify-content: space-between; font-size: 12px; color: #55525c; }
.fs-percent { font-weight: 600; color: #8e2b77; }
.fs-note { margin: 10px 0 0; font-size: 12px; line-height: 1.5; color: #6b6875; }
.fs-btn {
  margin-top: 10px;
  width: 100%;
  border: 1px solid #8e2b77;
  background: #fff;
  color: #8e2b77;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
}
.fs-btn:disabled { opacity: .6; }
.fs-log-title { margin-top: 14px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #8f889b; }
.fs-log-row { display: flex; gap: 10px; margin-top: 6px; font-size: 12px; }
.fs-log-time { color: #9a9c9d; flex-shrink: 0; }
.fs-log-text { color: #55525c; }
.fs-fine { margin: 14px 0 0; font-size: 10px; line-height: 1.4; color: #9a9c9d; }
</style>
