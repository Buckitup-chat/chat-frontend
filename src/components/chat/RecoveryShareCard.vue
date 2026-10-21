<template>
  <!-- A backup piece in the dialog (pq_recovery_shares § Holding): a card, not the text label. -->
  <div class="msg-share" :class="{ _problem: problem }" data-test="share-card">
    <template v-if="view.kind === 'kept_share'">
      <div class="fw-semibold">🔐 {{ peerName }}'s backup piece</div>
      <div class="msg-share-meta">Version {{ view.version }} · piece {{ view.shareIndex }}</div>
      <div class="msg-share-state" data-test="share-state">{{ stateText }}</div>
      <button v-if="view.canGiveBack" type="button" class="btn btn-sm btn-outline-secondary mt-1" :disabled="busy"
        data-test="give-back" @click="emit('giveBack', view.key)">Give back</button>
    </template>
    <template v-else>
      <div class="fw-semibold">🔐 Your backup piece for {{ peerName }}</div>
      <div class="msg-share-state" data-test="share-state">{{ sentText }}</div>
      <div v-if="hint" class="msg-share-hint">{{ hint }}</div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { keptStateIsProblem, keptStateText } from '@/components/recovery/holdingWords';
import { deliveryHint } from '@/components/recovery/backup/backupFlow';

const props = defineProps({
  /** One entry of useRecoveryShares' views: kept_share (the guardian's) or sent_share (the owner's). */
  view: { type: Object, required: true },
  peerName: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['giveBack']);

const stateText = computed(() => keptStateText(props.view.state, props.view.detail));
// The owner's piece by what the guardian said (receipts.ts Delivery); a share outside the backup's record is just sent.
const SENT = {
  waiting: 'Not sent yet',
  sent: 'Sent',
  delivered: 'Delivered',
  stored: 'They stored it ✓',
  problem: 'They report a problem',
  given_back: 'They gave it back',
  dropped: 'They no longer keep it',
};
const sentText = computed(() => SENT[props.view.state] ?? 'Sent');
const hint = computed(() => (props.view.kind === 'sent_share' ? deliveryHint(props.view.state, props.view.detail) : null));
const problem = computed(() => (props.view.kind === 'kept_share' ? keptStateIsProblem(props.view.state) : !!hint.value));
</script>

<style scoped>
.msg-share {
  border: 1px solid rgba(0, 0, 0, .12);
  border-radius: 10px;
  padding: 8px 10px;
  max-width: 320px;
  font-size: 14px;
}
.msg-share._problem { border-color: #fcb75c; }
.msg-share-meta { font-size: 12px; opacity: .7; margin-top: 2px; }
.msg-share-state { font-size: 13px; margin-top: 4px; }
.msg-share._problem .msg-share-state { color: #b35c00; }
.msg-share-hint { font-size: 12px; color: #b35c00; margin-top: 4px; }
</style>
