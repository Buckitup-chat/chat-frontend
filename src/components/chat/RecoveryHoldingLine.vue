<template>
  <!-- A guardian's word on a backup piece (07 § recovery_holding): a service line, not a message. -->
  <div class="msg-holding" :class="{ _ok: view.state === 'stored' }" data-test="holding-line">🔐 {{ text }}</div>
</template>

<script setup>
import { computed } from 'vue';
import { holdingLineText } from '@/components/recovery/holdingWords';

const props = defineProps({
  /** { state, detail, mine }: the report, and whether this account sent it. */
  view: { type: Object, required: true },
  peerName: { type: String, default: '' },
});

const text = computed(() => holdingLineText(props.view, props.peerName));
</script>

<style scoped>
.msg-holding {
  font-size: 12px;
  font-style: italic;
  opacity: .8;
  max-width: 320px;
}
.msg-holding._ok { color: #1f5e18; }
</style>
