<template>
	<component :is="to ? 'router-link' : 'div'" :to="to" class="ui-row"
		:class="{ _selected: selected, _clickable: clickable, _bare: bare }"
		:role="!to && clickable ? 'button' : undefined" :tabindex="!to && clickable ? 0 : undefined"
		@click="clickable && !to && $emit('select')" @keydown.enter="clickable && !to && $emit('select')">
		<div v-if="icon || $slots.lead" class="_lead" :class="tone && `_${tone}`">
			<slot name="lead"><i :class="`_icon_${icon}`"></i></slot>
		</div>
		<div class="_text">
			<div class="_title">{{ title }}<slot name="title-after" /></div>
			<div v-if="sub" class="_sub" :class="tone && `_${tone}`">{{ sub }}</div>
		</div>
		<slot name="trail">
			<span v-if="dot" class="_dot" :class="`_${dot}`"></span>
			<i v-if="chevron ?? clickable" class="_chevron _icon_back"></i>
		</slot>
	</component>
</template>

<script setup>
// A menu item: icon tile, title, second line, chevron (Foundations § 5).
// `tone` colours the tile and the second line by status; `dot` is a status
// dot on the right; `selected` is the desktop's current item.
import { computed } from 'vue';

const props = defineProps({
	title: { type: String, required: true },
	sub: { type: String, default: '' },
	icon: { type: String, default: '' },
	tone: { type: String, default: '' }, // success | warning | danger | accent
	dot: { type: String, default: '' }, // success | warning | danger
	to: { type: [String, Object], default: null },
	selected: { type: Boolean, default: false },
	chevron: { type: Boolean, default: undefined },
	bare: { type: Boolean, default: false }, // no tile behind the icon (desktop sidebar)
	button: { type: Boolean, default: false },
});
defineEmits(['select']);

const clickable = computed(() => !!props.to || props.button);
</script>

<style lang="scss" scoped>
.ui-row {
	position: relative;
	display: flex;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-3) var(--space-4);
	min-height: 64px;
	color: var(--color-text);
	text-decoration: none;
	border-radius: var(--radius-card);

	&._clickable {
		cursor: pointer;
		&:hover { background: var(--color-surface); }
	}
	&:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }

	&._selected {
		background: var(--color-accent-tint);
		color: var(--color-accent-dark);
		._sub { color: var(--color-accent-dark); }
		._lead { background: var(--color-bg); }
		._lead i { background-color: var(--color-accent); }
	}
}

// rows in one card: a hairline between them, from the text's left edge
.ui-row + .ui-row::before {
	content: '';
	position: absolute;
	top: 0;
	left: calc(var(--space-4) + 40px + var(--space-3));
	right: var(--space-4);
	border-top: 1px solid var(--color-border);
}

._lead {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	border-radius: var(--radius-input);
	background: var(--color-surface);

	i { width: 20px; height: 20px; background-color: var(--color-text); }

	&._success { background: var(--color-success-bg); i { background-color: var(--color-success); } }
	&._warning { background: var(--color-warning-bg); i { background-color: var(--color-warning); } }
	&._danger { background: var(--color-danger-bg); i { background-color: var(--color-danger); } }
	&._accent { background: var(--color-accent-tint); i { background-color: var(--color-accent); } }
}

._bare ._lead {
	width: 24px;
	background: transparent;
	i { width: 22px; height: 22px; }
}

._text {
	flex: 1;
	min-width: 0;
}

._title {
	font-size: var(--text-base);
	line-height: var(--leading-base);
	display: flex;
	align-items: center;
	gap: var(--space-2);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

._sub {
	font-size: var(--text-sm);
	line-height: var(--leading-sm);
	color: var(--color-text-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;

	&._success { color: var(--color-success); }
	&._warning { color: var(--color-warning); }
	&._danger { color: var(--color-danger); }
	&._accent { color: var(--color-accent); }
}

._chevron {
	flex-shrink: 0;
	width: 16px;
	height: 16px;
	transform: rotate(180deg);
	background-color: var(--color-text-muted);
}

._dot {
	flex-shrink: 0;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	&._success { background: var(--color-success-solid); }
	&._warning { background: var(--color-warning-solid); }
	&._danger { background: var(--color-danger-solid); }
}
</style>
