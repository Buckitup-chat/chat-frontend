<template>
	<div class="health" :class="`health-${view.level}`">
		<div class="health-head">
			<span class="health-count">{{ view.holders }} of {{ view.total }}</span>
			<span class="health-label">guardians hold a piece</span>
		</div>
		<div class="health-bar" aria-hidden="true">
			<template v-for="(seg, i) in segments" :key="i">
				<span v-if="i === view.needed" class="health-mark"></span>
				<span class="health-seg" :class="seg"></span>
			</template>
			<span v-if="view.needed >= segments.length" class="health-mark"></span>
		</div>
		<div class="health-detail">{{ view.detail }}<template v-if="extra"> · {{ extra }}</template></div>
	</div>
</template>

<script setup>
import { computed } from 'vue';

// The one number that answers "is my backup real" (design § 1): a segment per
// guardian, a mark at the number needed. Held segments are coloured by the
// level, pieces still on their way are pink rather than grey.
const props = defineProps({
	/** backupFlow.healthView(run). */
	view: { type: Object, required: true },
	/** Appended to the detail line, as on the card: "2 spare pieces · alerts: app". */
	extra: { type: String, default: '' },
});

const segments = computed(() =>
	Array.from({ length: props.view.total }, (_, i) => {
		if (i < props.view.holders) return 'held';
		if (i < props.view.holders + props.view.onTheWay) return 'way';
		return 'empty';
	}),
);
</script>

<style lang="scss" scoped>
.health {
	display: flex;
	flex-direction: column;
	gap: 6px;
	border-radius: 12px;
	padding: 12px 14px;
	background: #f2f2f2;
}
.health-head {
	display: flex;
	align-items: baseline;
	gap: 6px;
	flex-wrap: wrap;
}
.health-count {
	font-weight: 700;
	font-size: 24px;
	line-height: 1;
}
.health-label {
	font-weight: 500;
	font-size: 13px;
}
.health-bar {
	display: flex;
	gap: 4px;
	align-items: center;
}
.health-seg {
	flex: 1;
	height: 8px;
	border-radius: 999px;
	background: #dfdfdf;
	&.held {
		background: #2ebe21;
	}
	&.way {
		background: #f7e0f7;
	}
}
.health-mark {
	width: 2px;
	height: 16px;
	background: #000;
	border-radius: 1px;
}
.health-detail {
	font-size: 12px;
	line-height: 1.35;
	color: #6c757d;
}
.health-at_threshold {
	background: #fff4e3;
	.health-count,
	.health-detail {
		color: #a8620c;
	}
	.health-seg.held {
		background: #fcb75c;
	}
	.health-seg.empty {
		background: #ecd9bd;
	}
}
.health-broken {
	background: #fdecee;
	.health-count,
	.health-detail {
		color: #b02a37;
	}
	.health-seg.held {
		background: #dc3545;
	}
	.health-seg.empty {
		background: #f1c4c9;
	}
}
</style>
