<template>
  <div class="chat-window d-flex flex-column w-100 h-100">
    <!-- Header -->
    <div class="chat-header d-flex align-items-center px-3 py-2 border-bottom">
      <button class="btn btn-link text-decoration-none p-0 me-3 text-dark" @click="$router.back()">
        <i class="bi bi-arrow-left fs-4"></i> &larr;
      </button>
      <div class="d-flex align-items-center text-dark">
        <!-- Avatar -->
        <div class="avatar bg-secondary rounded-circle me-2 d-flex align-items-center justify-content-center overflow-hidden" style="width: 40px; height: 40px; flex-shrink: 0;">
          <img v-if="avatarUrl" :src="avatarUrl" @error="(event) => (event.target.src = defaultAvatar)" style="width: 100%; height: 100%; object-fit: cover;" />
          <Avatar v-else-if="avatarHash" :name="avatarHash" variant="bauhaus" style="width: 100%; height: 100%;" />
        </div>
        <div class="fw-bold fs-5">{{ title }}</div>
      </div>
    </div>

    <!-- Messages Area -->
    <div class="chat-body flex-grow-1 p-3 overflow-y-auto" ref="messagesContainer">
      <div 
        v-for="msg in messages" 
        :key="msg.id" 
        class="message-wrapper d-flex mb-3"
        :class="msg.isMine ? 'justify-content-end' : 'justify-content-start'"
      >
        <div 
          class="message-bubble p-2 rounded-3 shadow-sm"
          :class="msg.isMine ? 'message-mine' : 'message-peer'"
          style="max-width: 75%; min-width: 150px;"
        >
          <div v-if="!msg.isMine && showAuthorName" class="fw-bold text-muted mb-1" style="font-size: 0.8rem;">
            {{ msg.authorName }}
          </div>
          <div class="message-text text-break">
            {{ msg.text }}
          </div>
          <div class="message-time text-end mt-1" :class="msg.isMine ? 'text-dark' : 'text-muted'">
            {{ msg.timestamp }}
          </div>
        </div>
      </div>
    </div>

    <!-- Footer / Input -->
    <div class="chat-footer p-2 border-top">
      <form @submit.prevent="submitMessage" class="d-flex align-items-center m-0">
        <input 
          type="text" 
          class="form-control me-2 rounded-pill px-3" 
          v-model="newMessage" 
          placeholder="Type a message..." 
          required
        />
        <button type="submit" class="btn btn-primary rounded-circle d-flex align-items-center justify-content-center border-0" style="width: 40px; height: 40px; padding: 0;">
          &#10148;
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Avatar from 'vue-boring-avatars';

const $router = useRouter();
const defaultAvatar = '/img/profile.webp';

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
  }
});

const emit = defineEmits(['sendMessage']);

const newMessage = ref('');
const messagesContainer = ref(null);

const submitMessage = () => {
  if (newMessage.value.trim() !== '') {
    emit('sendMessage', newMessage.value.trim());
    newMessage.value = '';
  }
};

const scrollToBottom = async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
};

onMounted(() => {
  scrollToBottom();
});

watch(() => props.messages, () => {
  scrollToBottom();
}, { deep: true });
</script>

<style lang="scss" scoped>
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
  background-color: #F7E0F7; /* Purple-ish from old design */
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

.message-time {
  font-size: 10px;
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
  background: rgba(255,255,255,0.2);
  border-radius: 3px;
}
</style>