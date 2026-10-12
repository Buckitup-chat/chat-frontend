<template>
	<!-- Full-screen viewer over a list of pictures: counter in the header,
	     caption under the frame, a strip of every frame — frames still on
	     their way read as dimmed. Arrows, arrow keys and a horizontal swipe
	     step through, wrapping at either end. -->
	<div v-if="frame" class="lightbox" @click.self="emit('close')"
		@touchstart.passive="onTouchStart" @touchend="onTouchEnd">
		<div class="lightbox-bar">
			<span class="lightbox-count">{{ index + 1 }} {{ countJoin }} {{ frames.length }}</span>
			<button type="button" class="lightbox-close" @click="emit('close')" title="Close">✕</button>
		</div>
		<button v-if="frames.length > 1" type="button" class="lightbox-nav _prev" @click.stop="step(-1)">‹</button>
		<div class="lightbox-frame">
			<img v-if="frame.src" :src="frame.src" :alt="frame.alt || ''" />
			<img v-else-if="frame.placeholder" class="_blur" :src="frame.placeholder" alt="" />
			<div v-if="frame.error" class="lightbox-progress _err">{{ frame.error }}</div>
			<div v-else-if="frame.progress" class="lightbox-progress">{{ frame.progress }}</div>
		</div>
		<button v-if="frames.length > 1" type="button" class="lightbox-nav _next" @click.stop="step(1)">›</button>
		<div v-if="frame.caption" class="lightbox-caption">{{ frame.caption }}</div>
		<div v-if="$slots.actions" class="lightbox-actions">
			<slot name="actions" :frame="frame" :index="index"></slot>
		</div>
		<div v-if="frames.length > 1" class="lightbox-strip">
			<button v-for="(it, i) in frames" :key="it.key" type="button"
				class="lightbox-thumb" :class="{ _active: i === index, _pending: !it.src }"
				@click.stop="emit('update:index', i)">
				<img v-if="it.src || it.placeholder" :src="it.src || it.placeholder" alt="" />
			</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.lightbox {
	position: fixed;
	inset: 0;
	z-index: 1080;
	background: rgba(23, 22, 26, .92);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 10px;
	padding: 16px;
}
.lightbox-bar {
	position: absolute;
	top: 0; left: 0; right: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 16px;
	color: #fff;
}
.lightbox-count { font-size: 13px; font-weight: 500; }
.lightbox-close { background: none; border: none; color: #fff; font-size: 20px; line-height: 1; }
.lightbox-frame {
	position: relative;
	max-width: min(92vw, 1100px);
	max-height: 74vh;
	display: flex;
	align-items: center;
	justify-content: center;
}
.lightbox-frame img { max-width: 100%; max-height: 74vh; object-fit: contain; display: block; }
.lightbox-frame img._blur { filter: blur(8px); }
.lightbox-progress {
	position: absolute;
	left: 8px;
	bottom: 8px;
	background: rgba(23, 22, 26, .65);
	color: #fff;
	border-radius: 6px;
	padding: 2px 7px;
	font-size: 11px;
}
.lightbox-progress._err { background: rgba(220, 53, 69, .85); }
.lightbox-nav {
	position: absolute;
	top: 50%;
	transform: translateY(-50%);
	background: rgba(255, 255, 255, .12);
	border: none;
	color: #fff;
	font-size: 28px;
	line-height: 1;
	width: 44px;
	height: 44px;
	border-radius: 50%;
}
.lightbox-nav._prev { left: 12px; }
.lightbox-nav._next { right: 12px; }
.lightbox-caption { color: #fff; font-size: 13px; max-width: min(92vw, 1100px); text-align: center; }
.lightbox-actions { display: flex; gap: 8px; }
.lightbox-strip {
	display: flex;
	gap: 6px;
	max-width: min(92vw, 1100px);
	overflow-x: auto;
	padding: 2px;
}
.lightbox-thumb {
	flex-shrink: 0;
	width: 46px; height: 46px;
	padding: 0;
	border: 1.5px solid transparent;
	border-radius: 8px;
	overflow: hidden;
	background: rgba(255, 255, 255, .12);
}
.lightbox-thumb._active { border-color: #8e2b77; }
/* a frame still on its way reads as dimmed, so the strip doubles as a
   "which of these are here" indicator */
.lightbox-thumb._pending { opacity: .5; }
.lightbox-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>

<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
	/** { key, src, placeholder?, alt?, caption?, progress?, error? } per frame; `src` empty while the picture is on its way. */
	frames: { type: Array, required: true },
	index: { type: Number, default: 0 },
	/** Between the position and the total in the counter: "2 / 5", "2 of 5". */
	countJoin: { type: String, default: '/' },
});

const emit = defineEmits(['update:index', 'close']);

const frame = computed(() => props.frames[props.index] ?? null);

const step = (delta) => {
	const total = props.frames.length;
	if (!total) return emit('close');
	emit('update:index', (props.index + delta + total) % total);
};

const onKey = (e) => {
	if (e.key === 'ArrowLeft') step(-1);
	else if (e.key === 'ArrowRight') step(1);
	else if (e.key === 'Escape') emit('close');
};

// A swipe is a mostly horizontal move of at least 40px; anything else is a tap or a scroll.
let touchStart = null;
const onTouchStart = (e) => {
	const t = e.touches?.[0];
	touchStart = t ? { x: t.clientX, y: t.clientY } : null;
};
const onTouchEnd = (e) => {
	const t = e.changedTouches?.[0];
	if (!touchStart || !t || props.frames.length < 2) return;
	const dx = t.clientX - touchStart.x;
	const dy = t.clientY - touchStart.y;
	touchStart = null;
	if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
};

onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>
