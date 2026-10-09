<template>
  <!-- A guardian invitation or its answer (pq_recovery_shares § Inviting): a card, not a text bubble. -->
  <div class="msg-invite">
    <template v-if="view.kind === 'sent_invite'">
      <div class="fw-semibold">🛡 You asked them to be your guardian</div>
      <div class="msg-invite-state">{{ sentText }}</div>
    </template>
    <template v-else-if="view.kind === 'received_invite'">
      <div class="fw-semibold">🛡 {{ peerName }} asks you to be their guardian</div>
      <div class="msg-invite-text">
        You would keep a part of their backup. If they ever lose access, you check that it is really them and
        approve their recovery. Approving costs you nothing.
      </div>
      <div v-if="view.blocker === 'not_confirmed'" class="msg-invite-warn">
        You have not confirmed this contact in person, so you can only decline.
      </div>
      <div v-else-if="view.blocker === 'unreachable'" class="msg-invite-warn">
        It names a network this app cannot approve on, so you can only decline.
      </div>
      <div v-if="view.answer" class="msg-invite-state">{{ view.answer === 'accept' ? 'You accepted.' : 'You declined.' }}</div>
      <div class="d-flex gap-2 mt-1">
        <button v-if="!view.answer && !view.blocker" type="button" class="btn btn-sm btn-dark" :disabled="busy"
          @click="answer(true)">Accept</button>
        <!-- A decline at any time withdraws; accepting again takes a new invitation. -->
        <button v-if="view.answer !== 'decline'" type="button" class="btn btn-sm btn-outline-secondary" :disabled="busy"
          @click="answer(false)">{{ view.answer === 'accept' ? 'Withdraw' : 'Decline' }}</button>
      </div>
    </template>
    <template v-else>
      <div class="fw-semibold">🛡 {{ replyTitle }}</div>
      <div v-if="view.problem" class="msg-invite-warn">Ignored: {{ view.problem }}</div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** One entry of inviteThread.inviteViews. */
  view: { type: Object, required: true },
  peerName: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['answer']);

const SENT = {
  pending: 'Waiting for their answer.',
  accepted: 'They accepted.',
  declined: 'They declined.',
  void: 'Their answers disagree; ask again.',
  superseded: 'Replaced by a newer invitation.',
  unrecorded: "Not in this account's records; ask again.",
};

const sentText = computed(() => SENT[props.view.state] + (props.view.problems?.length ? ` Ignored: ${props.view.problems.join('; ')}.` : ''));
const replyTitle = computed(() => {
  const { answer, mine } = props.view;
  const verb = answer === 'accept' ? 'accepted' : answer === 'decline' ? 'declined' : 'answered';
  return mine ? `You ${verb} the invitation` : `They ${verb} the invitation`;
});

const answer = (accept) => emit('answer', { inviteId: props.view.inviteId, deployment: props.view.deployment, accept });
</script>

<style scoped>
.msg-invite {
  border: 1px solid rgba(0, 0, 0, .12);
  border-radius: 10px;
  padding: 8px 10px;
  max-width: 320px;
  font-size: 14px;
}
.msg-invite-text { font-size: 13px; margin: 4px 0; }
.msg-invite-state { font-size: 13px; opacity: .8; margin-top: 2px; }
.msg-invite-warn { font-size: 12px; color: #b35c00; margin-top: 4px; }
</style>
