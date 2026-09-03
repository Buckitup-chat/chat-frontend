<template>
  <div class="chat-window d-flex flex-column w-100 h-100">
    <!-- Header -->
    <div class="chat-header d-flex align-items-center justify-content-between px-3 py-2 border-bottom">
      <div class="d-flex align-items-center text-dark">
        <!-- Avatar -->
        <div
          class="avatar bg-secondary rounded-circle me-2 d-flex align-items-center justify-content-center overflow-hidden"
          style="width: 40px; height: 40px; flex-shrink: 0;">
          <img loading="lazy" v-if="avatarUrl" :src="avatarUrl" @error="(event) => (event.target.src = defaultAvatar)"
            style="width: 100%; height: 100%; object-fit: cover;" />
          <Avatar v-else-if="avatarHash" :name="avatarHash" variant="bauhaus" style="width: 100%; height: 100%;" />
        </div>
        <div class="fw-bold fs-5">{{ title }}</div>
      </div>
      <div class="_toggler" @click="toggleMenu()" v-if="$breakpoint.lt('md')">
        <div :class="{ _open: $menuOpened }"><span></span><span></span><span></span><span></span></div>
      </div>
    </div>

    <!-- Messages Area -->
    <div class="chat-body flex-grow-1 p-3 overflow-y-auto" ref="messagesContainer">
        <div v-for="msg in messages" :key="msg.id" class="message-wrapper d-flex mb-3"
        :class="msg.isMine ? 'justify-content-end' : 'justify-content-start'">
        <div class="message-bubble p-2 rounded-3 shadow-sm"
          :data-msg-id="msg.id"
          :class="[msg.isMine ? 'message-mine' : 'message-peer', {
            'message-pending': msg._syncStatus && msg._syncStatus !== 'synced' && msg._syncStatus !== 'error',
            'message-error': msg._syncStatus === 'error',
            'message-unplaced': msg._verify === 'waiting',
          }]"
          style="max-width: 75%; min-width: 150px;" @contextmenu.prevent="openContextMenu($event, msg)">
          <div v-if="!msg.isMine && showAuthorName" class="fw-bold text-muted mb-1" style="font-size: 0.8rem;">
            {{ msg.authorName }}
          </div>
          <div v-if="editingMessageId === msg.id" class="message-edit">
            <textarea ref="editTextarea" v-model="editingText" class="form-control form-control-sm mb-1" rows="2"
              @keydown.enter.exact.prevent="saveEdit" @keydown.esc.prevent="cancelEdit"></textarea>
            <div class="d-flex gap-1 justify-content-end">
              <button type="button" class="btn btn-sm btn-light" @click="cancelEdit">Cancel</button>
              <button type="button" class="btn btn-sm btn-primary" @click="saveEdit">Save</button>
            </div>
          </div>
          <div v-else>
            <!-- Quotes render from their own snapshot (the reply carries the
                 cited content), so they work even when the original never
                 arrived or was deleted — the jump just degrades honestly. -->
            <div v-for="(q, qi) in quotesOf(msg)" :key="qi" class="msg-quote" role="button"
              :class="{ '_historic': quoteOriginalDeleted(q) }"
              @click="jumpToMessage(q.messageId)">
              <div class="msg-quote-bar"></div>
              <div class="msg-quote-body">
                <div class="msg-quote-author">{{ quoteAuthorName(q.authorHash) }}</div>
                <div class="msg-quote-text">{{ quotePreview(q) }}</div>
                <div v-if="quoteOriginalDeleted(q)" class="msg-quote-note">original deleted by author</div>
                <div v-else-if="!quoteOriginalPresent(q)" class="msg-quote-note"><span class="msg-quote-dot"></span>original not synced yet</div>
              </div>
            </div>
            <!-- §1.3: the picture's box is reserved from the aspect ratio in
                 the message and filled with the ThumbHash blur, so the bubble
                 does not jump when the bytes land. -->
            <div v-for="im in imagesOf(msg)" :key="im.fileId" class="msg-image"
              :style="{ aspectRatio: im.widthAspect + ' / ' + im.heightAspect }"
              @click="images[im.fileId]?.url && emit('showImage', im)">
              <img v-if="thumbUrl(im)" class="msg-image-blur" :src="thumbUrl(im)" alt="" />
              <img v-if="images[im.fileId]?.url" class="msg-image-full" :src="images[im.fileId].url" :alt="im.name" />
              <div v-if="images[im.fileId]?.status === 'downloading'" class="msg-image-progress">
                {{ images[im.fileId].done }} / {{ images[im.fileId].total }} chunks
              </div>
              <div v-else-if="images[im.fileId]?.status === 'error'" class="msg-image-progress _err">
                image failed — tap to retry
              </div>
            </div>

            <!-- §1.5 file row: icon — name — size/state — action. Progress is
                 chunks, never guessed percentages (§2.1). -->
            <div v-for="f in filesOf(msg)" :key="f.fileId" class="msg-file">
              <span class="msg-file-icon">📄</span>
              <div class="msg-file-body">
                <div class="msg-file-name">{{ f.name }}</div>
                <div class="msg-file-meta">
                  <template v-if="downloads[f.fileId]?.status === 'downloading'">
                    {{ fmtSize(f.size) }} · chunk {{ downloads[f.fileId].done }} of {{ downloads[f.fileId].total }}
                  </template>
                  <template v-else-if="downloads[f.fileId]?.status === 'error'">
                    {{ fmtSize(f.size) }} · <span class="msg-file-err">download failed — tap to retry</span>
                  </template>
                  <template v-else-if="downloads[f.fileId]?.status === 'done'">
                    {{ fmtSize(f.size) }} · saved
                  </template>
                  <template v-else>{{ fmtSize(f.size) }}</template>
                </div>
              </div>
              <button v-if="downloads[f.fileId]?.status !== 'downloading'" type="button"
                class="msg-file-action" @click="emit('downloadFile', f)"
                :title="downloads[f.fileId]?.status === 'done' ? 'Save again' : 'Download and decrypt'">⭳</button>
              <span v-else class="msg-file-spinner"></span>
            </div>
            <div v-if="msg._deleted" class="message-text fst-italic text-muted">Message deleted</div>
            <div v-else class="message-text text-break">
              {{ msg.text }}
            </div>
            <!-- §4.2: admitted but causally unplaced — say why, quietly. -->
            <div v-if="msg._verify === 'waiting'" class="msg-unplaced-note">waiting for earlier messages…</div>
          </div>
          <!-- §3.1 history: struck-through past revisions, newest first. Each
               was signature-verified upstream; an unverifiable one says so. -->
          <div v-if="openHistories.has(msg.id)" class="msg-history">
            <div v-if="!histories[msg.id]" class="msg-history-loading">loading…</div>
            <div v-else-if="histories[msg.id].length === 0" class="msg-history-loading">no earlier versions synced</div>
            <div v-else v-for="v in histories[msg.id]" :key="v.signHash" class="msg-history-item">
              <span class="msg-history-tag">historical version</span>
              <div class="msg-history-text" :class="{ '_unverified': !v.verified }">{{ v.deletedFlag ? 'deleted' : v.text }}</div>
            </div>
          </div>
          <div v-if="reactions[msg.id] && Object.keys(reactions[msg.id]).length > 0"
            class="reactions-container d-flex flex-wrap gap-1 mt-1">
            <button v-for="(data, emoji) in reactions[msg.id]" :key="emoji" type="button"
              class="reaction-badge btn btn-sm p-0 px-2 rounded-pill d-inline-flex align-items-center"
              :class="{
                'reaction-mine': data.hasMine,
                'reaction-pending': data.status === 'sending' || data.status === 'syncing',
                'reaction-error': data.status === 'error'
              }"
              @click="handleReactionClick(msg.id, emoji)"
              :title="data.status === 'error' ? 'Not synced — click to retry' : (data.hasMine ? 'Remove' : 'React')">
              <span class="reaction-emoji">{{ emoji }}</span>
              <span v-if="data.count > 1" class="reaction-count ms-1">{{ data.count }}</span>
            </button>
          </div>
          <div class="message-time text-end mt-1" :class="msg.isMine ? 'text-dark' : 'text-muted'">
            {{ msg.timestamp }}
            <!-- §4.3: ◌ stored locally → pale ✓ in flight → ✓ server-accepted.
                 (✓✓ delivered needs delivery receipts; ↻ auto-retry needs the
                 outbox hook — both arrive with their transports.) -->
            <span v-if="msg._syncStatus === 'sending'" class="sync-status local" title="Saved locally">◌</span>
            <span v-else-if="msg._syncStatus === 'syncing'" class="sync-status pending" title="Sending…">✓</span>
            <span v-else-if="msg._syncStatus === 'synced'" class="sync-status synced" title="Accepted by server">✓</span>
            <span v-else-if="msg._syncStatus === 'error'" class="sync-status error" title="Rejected — not sent">!</span>
            <span v-if="msg._raw && msg._raw.parent_sign_hash" class="msg-edited" role="button"
              :title="openHistories.has(msg.id) ? 'Hide history' : 'Show previous versions'"
              @click.stop="toggleHistory(msg.id)">edited<template v-if="versionCountOf(msg)"> · {{ versionCountOf(msg) }}</template></span>
            <!-- A versioned edit that the server did not accept: others still
                 see the previous revision, so say so instead of showing the
                 attempted text as if it had landed. -->
            <span v-if="msg._editStatus === 'syncing'" class="sync-status pending" title="Saving edit…">✎</span>
            <span v-else-if="msg._editStatus === 'error'" class="sync-status error" title="Edit not saved — others still see the previous version">✎!</span>
            <!-- Read receipts are irreversible and tied to this exact revision,
                 so they are only ever produced by the explicit action below. -->
            <span v-if="msg.isMine && msg._acknowledgedByPeers > 0" class="sync-status acknowledged"
              title="Recipient confirmed reading this version">&#128065;</span>
            <span v-else-if="!msg.isMine && msg._acknowledgedByMe" class="sync-status acknowledged"
              title="You confirmed reading this version">&#128065;</span>
            <span v-else-if="!msg.isMine && msg._acknowledgePending" class="sync-status pending"
              title="Sending confirmation…">&#128065;</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer / Input -->
    <div class="chat-footer p-2 border-top">
      <!-- §2.1 upload strip: name, chunk progress, cancel. Colour lives in
           the caption, not the button. -->
      <div v-for="u in uploads" :key="u.id" class="upload-strip d-flex align-items-center gap-2 mb-1 px-2 py-1">
        <span class="msg-file-icon">📄</span>
        <div class="flex-grow-1" style="min-width:0">
          <div class="msg-file-name">{{ u.name }}</div>
          <div class="msg-file-meta" :class="{ 'msg-file-err': u.status === 'error' }">
            <template v-if="u.status === 'error'">upload failed</template>
            <template v-else-if="u.total">sending · chunk {{ u.done }} of {{ u.total }}</template>
            <template v-else>encrypting…</template>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-light rounded-circle" @click="emit('cancelUpload', u.id)" title="Cancel">✕</button>
      </div>
      <div v-if="replyTo" class="reply-preview d-flex align-items-center gap-2 mb-1 px-2 py-1">
        <div class="msg-quote-bar"></div>
        <div class="flex-grow-1" style="min-width:0">
          <div class="msg-quote-author">{{ quoteAuthorName(replyTo.authorHash) }}</div>
          <div class="msg-quote-text">{{ replyTo.previewText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-light rounded-circle" @click="cancelReply" title="Cancel reply">✕</button>
      </div>
      <form @submit.prevent="submitMessage" class="d-flex align-items-center m-0">
        <input ref="fileInput" type="file" class="d-none" @change="onFilePicked" />
        <button type="button" class="btn btn-light rounded-circle me-2 d-flex align-items-center justify-content-center border-0 attach-btn"
          style="width: 40px; height: 40px; padding: 0;" title="Attach a file" @click="fileInput?.click()">📎</button>
        <input type="text" class="form-control me-2 rounded-pill px-3" v-model="newMessage"
          placeholder="Type a message..." />
        <button type="submit"
          class="btn btn-primary rounded-circle d-flex align-items-center justify-content-center border-0"
          style="width: 40px; height: 40px; padding: 0;">
          &#10148;
        </button>
      </form>
    </div>

    <!-- Context Menu -->
    <div v-if="contextMenu" ref="contextMenuRef" class="context-menu"
      :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }" @click.stop>
      <div class="context-menu-reactions">
        <button v-for="emoji in EMOJI_CHOICES" :key="emoji" type="button" class="context-menu-emoji"
          @click="selectEmojiFromContext(emoji)">{{ emoji }}</button>
      </div>
      <div class="context-menu-divider"></div>
      <button v-if="contextMenuMsg && contextMenuMsg._raw && contextMenuMsg._raw.sign_hash && !contextMenuMsg._deleted"
        type="button" class="context-menu-action" @click="startReply(contextMenuMsg)">
        <i class="bi bi-reply me-2"></i>Reply
      </button>
      <button v-if="contextMenuMsg && contextMenuMsg.isMine && contextMenuMsg._syncStatus === 'synced'" type="button" class="context-menu-action"
        @click="startEdit(contextMenuMsg)">
        <i class="bi bi-pencil me-2"></i>Edit
      </button>
      <button v-if="canAcknowledge" type="button" class="context-menu-action"
        @click="acknowledgeFromContext">
        <i class="bi bi-eye me-2"></i>Confirm read
      </button>
      <button v-if="contextMenuMsg && contextMenuMsg.isMine && contextMenuMsg._syncStatus === 'synced' && !contextMenuMsg._deleted"
        type="button" class="context-menu-action context-menu-danger" @click="deleteFromContext">
        <i class="bi bi-trash me-2"></i>Delete
      </button>
      <button type="button" class="context-menu-action" @click="copyMessageText">
        <i class="bi bi-clipboard me-2"></i>Copy text
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { contentToText } from '@/lib/pq/content';
import { thumbHashToDataURL } from 'thumbhash';
import { fromBase64 } from '@/lib/pq/signature';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useMenu } from '@/composables/useMenu';
import Avatar from 'vue-boring-avatars';

const { isOpen: $menuOpened, toggle: toggleMenu } = useMenu();
const $breakpoint = useBreakpoint();
const defaultAvatar = '/img/profile.webp';

const EMOJI_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '💯', '👀', '🎉', '👏', '🤔', '😎', '🚀', '✨', '💪'];

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  avatarUrl: {
    type: String,
    default: ''
  },
  avatarHash: {
    type: String,
    default: ''
  },
  myHash: {
    type: String,
    default: ''
  },
  versionCounts: {
    type: Object,
    default: () => ({})
  },
  histories: {
    type: Object,
    default: () => ({})
  },
  uploads: {
    type: Array,
    default: () => []
  },
  downloads: {
    type: Object,
    default: () => ({})
  },
  images: {
    type: Object,
    default: () => ({})
  },
  messages: {
    type: Array,
    required: true,
  },
  showAuthorName: {
    type: Boolean,
    default: true
  },
  reactions: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits(['sendMessage', 'toggleReaction', 'editMessage', 'acknowledgeMessage', 'showHistory', 'deleteMessage', 'sendFile', 'cancelUpload', 'downloadFile', 'showImage']);

const newMessage = ref('');
const messagesContainer = ref(null);
const contextMenu = ref(null);
const contextMenuRef = ref(null);
const editingMessageId = ref(null);
const editingText = ref('');
const editTextarea = ref(null);

const contextMenuMsg = computed(() => {
  if (!contextMenu.value) return null;
  return props.messages.find((m) => m.id === contextMenu.value.msgId) || null;
});

// ---------- reply / quotes (design board §1.2) ----------

const replyTo = ref(null); // { messageId, signHash, authorHash, snapshot, previewText }

const startReply = (msg) => {
  // The snapshot travels inside the reply, frozen at citation time — the
  // quote must render even if the original later edits away or deletes.
  replyTo.value = {
    messageId: msg._raw.message_id,
    signHash: msg._raw.sign_hash,
    authorHash: msg._raw.sender_hash,
    snapshot: msg.parts && msg.parts.length ? msg.parts : [{ kind: 'text', text: msg.text }],
    previewText: msg.text || '…',
  };
  closeContextMenu();
};

const cancelReply = () => { replyTo.value = null; };

const deleteFromContext = () => {
  const msg = contextMenuMsg.value;
  closeContextMenu();
  // Deletion is a signed revision others will sync — worth one explicit check.
  if (msg && window.confirm('Delete this message? Peers will see it was deleted.')) {
    emit('deleteMessage', msg.id);
  }
};

const submitMessage = () => {
  if (newMessage.value.trim() !== '') {
    emit('sendMessage', newMessage.value.trim(), replyTo.value);
    newMessage.value = '';
    replyTo.value = null;
  }
};

// §3.1: past revisions are hidden by default and open per message.
const openHistories = ref(new Set());
const toggleHistory = (msgId) => {
  const next = new Set(openHistories.value);
  if (next.has(msgId)) next.delete(msgId);
  else {
    next.add(msgId);
    emit('showHistory', msgId); // parent loads and verifies on first open
  }
  openHistories.value = next;
};
const versionCountOf = (msg) => props.versionCounts[msg.id] || 0;

const quotesOf = (msg) => (msg.parts || []).filter((p) => p.kind === 'quote');
const filesOf = (msg) => (msg.parts || []).filter((p) => p.kind === 'file');
const imagesOf = (msg) => (msg.parts || []).filter((p) => p.kind === 'image');

// ThumbHash decodes to a tiny data URL; cached because it is pure and the
// list re-renders on every sync tick.
const thumbCache = new Map();
const thumbUrl = (im) => {
  if (!im.thumbHashB64) return '';
  if (thumbCache.has(im.fileId)) return thumbCache.get(im.fileId);
  let url = '';
  try {
    url = thumbHashToDataURL(fromBase64(im.thumbHashB64));
  } catch { /* a malformed hash just means no blur */ }
  thumbCache.set(im.fileId, url);
  return url;
};

const fmtSize = (n) => {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

const fileInput = ref(null);
const onFilePicked = (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  // The caption is whatever sits in the input — one composed message
  // (board screen 02: "подпись набирается в том же поле").
  emit('sendFile', file, newMessage.value.trim());
  newMessage.value = '';
};

// 1:1 dialog: the only two authors are me and the peer the window shows.
const quoteAuthorName = (hash) => (hash === props.myHash ? 'Me' : props.title);

const quotePreview = (q) => contentToText(q.snapshot) || '…';

const findOriginal = (q) => props.messages.find((m) => m.id === q.messageId);
const quoteOriginalPresent = (q) => !!findOriginal(q);
const quoteOriginalDeleted = (q) => !!findOriginal(q)?._deleted;

// §1.2 "Ссылка и переход": scroll to the original, highlight for 1.5s.
const jumpToMessage = (messageId) => {
  const el = messagesContainer.value?.querySelector(`[data-msg-id="${messageId}"]`);
  if (!el) return; // original not synced yet — the note under the quote says so
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-jump-highlight');
  setTimeout(() => el.classList.remove('msg-jump-highlight'), 1500);
};

const handleReactionClick = (messageId, emoji) => {
  emit('toggleReaction', messageId, emoji);
};

const clampContextMenuPosition = () => {
  if (!contextMenu.value || !contextMenuRef.value) return;
  const rect = contextMenuRef.value.getBoundingClientRect();
  const edgePadding = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(edgePadding, Math.min(contextMenu.value.x, vw - rect.width - edgePadding));
  const y = Math.max(edgePadding, Math.min(contextMenu.value.y, vh - rect.height - edgePadding));
  if (x !== contextMenu.value.x || y !== contextMenu.value.y) {
    contextMenu.value = { ...contextMenu.value, x, y };
  }
};

const openContextMenu = async (event, msg) => {
  event.preventDefault();
  contextMenu.value = { msgId: msg.id, x: event.clientX, y: event.clientY };
  await nextTick();
  clampContextMenuPosition();
};

const closeContextMenu = () => {
  contextMenu.value = null;
};

const handleDocumentClick = (event) => {
  if (event.button !== 0) return;
  closeContextMenu();
};

// Only the recipient acknowledges, only once, and only for a revision that
// actually exists on the server. Confirming is a deliberate act the user can
// never take back, so it lives behind an explicit menu item rather than being
// emitted when the message scrolls into view.
const canAcknowledge = computed(() => {
  const m = contextMenuMsg.value;
  return !!m && !m.isMine && !m._optimistic && !m._acknowledgedByMe && !m._acknowledgePending;
});

const acknowledgeFromContext = () => {
  const msgId = contextMenu.value?.msgId;
  closeContextMenu();
  if (msgId) emit('acknowledgeMessage', msgId);
};

const selectEmojiFromContext = (emoji) => {
  if (!contextMenu.value) return;
  emit('toggleReaction', contextMenu.value.msgId, emoji);
  closeContextMenu();
};

const copyMessageText = async () => {
  if (!contextMenu.value) return;
  const msg = props.messages.find((m) => m.id === contextMenu.value.msgId);
  if (msg && msg.text && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(msg.text);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  }
  closeContextMenu();
};

const startEdit = async (msg) => {
  editingMessageId.value = msg.id;
  editingText.value = msg.text;
  closeContextMenu();
  await nextTick();
  if (editTextarea.value) {
    editTextarea.value.focus();
    editTextarea.value.setSelectionRange(editTextarea.value.value.length, editTextarea.value.value.length);
  }
};

const saveEdit = () => {
  if (!editingMessageId.value || !editingText.value.trim()) return;
  emit('editMessage', editingMessageId.value, editingText.value.trim());
  editingMessageId.value = null;
  editingText.value = '';
};

const cancelEdit = () => {
  editingMessageId.value = null;
  editingText.value = '';
};

const handleEscape = (e) => {
  if (e.key === 'Escape') closeContextMenu();
};

const handleResize = () => {
  if (contextMenu.value) clampContextMenuPosition();
};

onMounted(() => {
  scrollToBottom();
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleEscape);
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('keydown', handleEscape);
  window.removeEventListener('resize', handleResize);
});

const scrollToBottom = async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
};

watch(() => props.messages, () => {
  scrollToBottom();
}, { deep: true });
</script>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

.chat-window {
  background: transparent;
}

.chat-header {
  background-color: #ffffff;
}

.message-bubble {
  position: relative;
}

.message-mine {
  background-color: #F7E0F7;
  /* Purple-ish from old design */
  color: #000;
  border-bottom-right-radius: 0 !important;
}

.message-peer {
  background-color: #FFFFFF;
  color: #000;
  border-bottom-left-radius: 0 !important;
}

.message-text {
  font-size: 0.95rem;
  line-height: 1.4;
  white-space: pre-wrap;
}

.message-edit textarea {
  resize: none;
  font-size: 0.95rem;
  line-height: 1.4;
}

.message-time {
  font-size: 10px;
}

.sync-status {
  display: inline-block;
  margin-left: 4px;
  font-size: 10px;
  line-height: 1;

  &.pending {
    opacity: 0.5;
  }

  &.synced {
    opacity: 1;
  }

  &.error {
    color: #dc3545;
    font-weight: bold;
  }

  &.acknowledged {
    opacity: 1;
    font-size: 11px;
  }
}

.message-pending {
  opacity: 0.75;
}

.reactions-container {
  position: relative;
}

.reaction-badge {
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(0, 0, 0, 0.08);
  font-size: 0.75rem;
  line-height: 1.4;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.95);
    transform: scale(1.05);
  }

  &.reaction-mine {
    background: #cce5ff;
    border-color: #99c2ff;
  }

  &.reaction-pending {
    opacity: 0.65;
  }

  // A failed sync must not look like an in-flight one
  &.reaction-error {
    opacity: 0.85;
    border-color: #dc3545;
    border-style: dashed;
  }
}

.reaction-emoji {
  font-size: 0.9rem;
}

.reaction-count {
  font-size: 0.7rem;
  font-weight: 600;
  color: #555;
}

.context-menu {
  position: fixed;
  z-index: 9999;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 0.5rem;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  padding: 0.4rem;
  min-width: fit-content;
  user-select: none;
}

.context-menu-reactions {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.15rem;
  padding: 0.25rem;
}

.context-menu-emoji {
  background: transparent;
  border: none;
  padding: 0.3rem;
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 0.3rem;
  transition: all 0.1s ease;

  &:hover {
    background: rgba(0, 0, 0, 0.06);
    transform: scale(1.3);
  }
}

.context-menu-divider {
  height: 1px;
  background: rgba(0, 0, 0, 0.08);
  margin: 0.3rem 0;
}

.context-menu-action {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: transparent;
  border: none;
  border-radius: 0.3rem;
  font-size: 0.9rem;
  color: #333;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s ease;

  &:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  i {
    font-size: 1rem;
  }
}

.chat-footer {
  background-color: #ffffff;
}

/* Custom scrollbar for better appearance */
.chat-body::-webkit-scrollbar {
  width: 6px;
}

.chat-body::-webkit-scrollbar-track {
  background: transparent;
}

.chat-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

._toggler {
  border: none;
  padding: 0.75rem 1rem;
  cursor: pointer;

  div {
    width: 22px;
    height: 20px;
    position: relative;
    transform: rotate(0deg);
    transition: 0.5s ease-in-out;
    cursor: pointer;

    span {
      display: block;
      position: absolute;
      height: 3px;
      width: 100%;
      background: $dark;
      border-radius: 2px;
      opacity: 1;
      left: 0;
      transform: rotate(0deg);
      transition: 0.25s ease-in-out;

      &:nth-child(1) {
        top: 0px;
      }

      &:nth-child(2),
      &:nth-child(3) {
        top: 8px;
      }

      &:nth-child(4) {
        top: 16px;
      }
    }

    &._open {
      span {
        &:nth-child(1) {
          top: 8px;
          width: 0%;
          left: 50%;
        }

        &:nth-child(2) {
          transform: rotate(45deg);
        }

        &:nth-child(3) {
          transform: rotate(-45deg);
        }

        &:nth-child(4) {
          top: 16px;
          width: 0%;
          left: 50%;
        }
      }
    }
  }
}

/* ---------- design board: quotes (§1.2) ---------- */
.msg-quote {
  display: flex;
  gap: 8px;
  background: rgba(36, 24, 36, .06);
  border-radius: 9px;
  padding: 6px 8px;
  margin-bottom: 6px;
  cursor: pointer;
}
.msg-quote-bar {
  width: 3px;
  border-radius: 999px;
  background: #8e2b77;
  flex-shrink: 0;
}
.msg-quote-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.msg-quote-author { font-size: 11px; line-height: 1.3; font-weight: 600; color: #8e2b77; }
.msg-quote-text {
  font-size: 12px;
  line-height: 1.35;
  color: #4a4750;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* original deleted: the quote turns historical — struck through, muted */
.msg-quote._historic .msg-quote-text { color: #8f889b; text-decoration: line-through; opacity: .9; }
.msg-quote-note { display: flex; align-items: center; gap: 5px; margin-top: 2px; font-size: 10px; line-height: 1.3; color: #9a9c9d; }
.msg-quote-dot { width: 5px; height: 5px; border-radius: 50%; background: #c2c2c6; }

.reply-preview { background: rgba(36, 24, 36, .06); border-radius: 9px; }

/* §1.2 jump: outline + halo for 1.5s on the original bubble */
.msg-jump-highlight { outline: 1.5px solid #8e2b77; box-shadow: 0 0 0 4px rgba(142, 43, 119, .22) !important; }

/* ---------- design board: send states (§4.3) ---------- */
.sync-status.local { color: #9a9c9d; }        /* ◌ stored locally */
.sync-status.pending { opacity: .45; }         /* pale ✓ in flight */
/* rejected outright: red frame on the bubble itself, not just the glyph */
.message-error { border: 1.5px solid #dc3545; }
.msg-edited { margin-left: 4px; font-size: 10px; color: #8e2b77; cursor: default; }

/* ---------- §4.2: admitted but causally unplaced ---------- */
.message-unplaced { opacity: .72; }
.msg-unplaced-note { margin-top: 2px; font-size: 10px; line-height: 1.3; color: #9a9c9d; }

.context-menu-danger { color: #dc3545; }

/* ---------- §3.1 version history ---------- */
.msg-history { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.msg-history-item { background: rgba(36, 24, 36, .06); border-radius: 9px; padding: 6px 8px; }
.msg-history-tag { font-size: 9px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: #8f889b; }
.msg-history-text { font-size: 12px; line-height: 1.35; color: #8f889b; text-decoration: line-through; opacity: .9; }
.msg-history-text._unverified { text-decoration: none; font-style: italic; }
.msg-history-loading { font-size: 11px; color: #9a9c9d; }

/* ---------- §1.5 / §2.1 files ---------- */
.msg-file { display: flex; align-items: center; gap: 8px; background: rgba(36, 24, 36, .06); border-radius: 9px; padding: 6px 8px; margin-bottom: 6px; }
.msg-file-icon { font-size: 18px; flex-shrink: 0; }
.msg-file-body { min-width: 0; flex-grow: 1; }
.msg-file-name { font-size: 12px; font-weight: 600; color: #241824; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-file-meta { font-size: 10px; color: #6b6875; }
.msg-file-err { color: #dc3545; }
.msg-file-action { border: none; background: #241824; color: #fff; border-radius: 999px; width: 26px; height: 26px; font-size: 13px; line-height: 1; flex-shrink: 0; }
.msg-file-spinner { width: 16px; height: 16px; border: 2px solid rgba(36,24,36,.2); border-top-color: #8e2b77; border-radius: 50%; flex-shrink: 0; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.upload-strip { background: rgba(36, 24, 36, .06); border-radius: 9px; }

/* ---------- §1.3 images ---------- */
.msg-image {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 6px;
  max-height: 340px;
  background: rgba(36, 24, 36, .06);
  cursor: pointer;
}
.msg-image-blur,
.msg-image-full {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* the blur sits underneath and is simply covered when the real image loads */
.msg-image-blur { filter: blur(6px); transform: scale(1.06); }
.msg-image-full { animation: msg-image-in .18s ease-out; }
@keyframes msg-image-in { from { opacity: 0 } to { opacity: 1 } }
.msg-image-progress {
  position: absolute;
  left: 6px; right: 6px; bottom: 6px;
  margin: 0 auto;
  width: fit-content;
  background: rgba(0, 0, 0, .45);
  color: #fff;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  line-height: 1.3;
}
.msg-image-progress._err { background: rgba(220, 53, 69, .85); }
</style>