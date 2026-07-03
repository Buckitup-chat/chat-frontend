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
          :class="[msg.isMine ? 'message-mine' : 'message-peer', { 'message-pending': msg._syncStatus && msg._syncStatus !== 'synced' }]"
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
          <div v-else class="message-text text-break">
            {{ msg.text }}
          </div>
          <div v-if="reactions[msg.id] && Object.keys(reactions[msg.id]).length > 0"
            class="reactions-container d-flex flex-wrap gap-1 mt-1">
            <button v-for="(data, emoji) in reactions[msg.id]" :key="emoji" type="button"
              class="reaction-badge btn btn-sm p-0 px-2 rounded-pill d-inline-flex align-items-center"
              :class="{ 'reaction-mine': data.hasMine, 'reaction-pending': data.status && data.status !== 'synced' }"
              @click="handleReactionClick(msg.id, emoji)"
              :title="data.hasMine ? 'Remove' : 'React'">
              <span class="reaction-emoji">{{ emoji }}</span>
              <span v-if="data.count > 1" class="reaction-count ms-1">{{ data.count }}</span>
            </button>
          </div>
          <div class="message-time text-end mt-1" :class="msg.isMine ? 'text-dark' : 'text-muted'">
            {{ msg.timestamp }}
            <span v-if="msg._syncStatus === 'sending' || msg._syncStatus === 'syncing'" class="sync-status pending" title="Syncing...">✓</span>
            <span v-else-if="msg._syncStatus === 'synced'" class="sync-status synced" title="Synced">✓</span>
            <span v-else-if="msg._syncStatus === 'error'" class="sync-status error" title="Failed to sync">!</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer / Input -->
    <div class="chat-footer p-2 border-top">
      <form @submit.prevent="submitMessage" class="d-flex align-items-center m-0">
        <input type="text" class="form-control me-2 rounded-pill px-3" v-model="newMessage"
          placeholder="Type a message..." required />
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
      <button v-if="contextMenuMsg && contextMenuMsg.isMine && contextMenuMsg._syncStatus === 'synced'" type="button" class="context-menu-action"
        @click="startEdit(contextMenuMsg)">
        <i class="bi bi-pencil me-2"></i>Edit
      </button>
      <button type="button" class="context-menu-action" @click="copyMessageText">
        <i class="bi bi-clipboard me-2"></i>Copy text
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
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

const emit = defineEmits(['sendMessage', 'toggleReaction', 'editMessage']);

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

const submitMessage = () => {
  if (newMessage.value.trim() !== '') {
    emit('sendMessage', newMessage.value.trim());
    newMessage.value = '';
  }
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
</style>