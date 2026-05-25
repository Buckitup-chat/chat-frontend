<template>
	<div class="_contacts_list" :class="{ _has_contacts: hasContacts }">
		<div class="_search mb-1" v-if="hasContacts">
			<div class="_input_search">
				<div class="_icon_search"></div>
				<input class="" type="text" v-model="search" autocomplete="off" placeholder="Search..." />

				<div class="_icon_times" v-if="search" @click="search = null"></div>
			</div>
		</div>
		<div class="_list">
			<div class="_contact" @click="select(contact.address)" v-for="contact in filteredList" :class="{ _selected: isSelected(contact.address) }">
				<Account_Item_PQ :account="contact" class="w-100" />
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._contacts_list {
	display: flex;
	flex-direction: column;
	overflow: hidden;

	&._has_contacts {
		flex-grow: 1;
		height: calc(100vh - 3rem);
	}

	._list {
		flex-grow: 1;
		overflow-y: auto;

		._contact {
			display: flex;
			align-items: center;
			padding: 0.5rem;
			width: 100%;
			cursor: pointer;
			border-radius: $blockRadiusSm;
			&:hover {
				background-color: lighten($black, 90%);
			}
			&._selected {
				background-color: lighten($black, 85%);
			}
		}
	}
}
</style>

<script setup>
import { ref, computed } from 'vue';
import Account_Item_PQ from '@/components/Account_Item_PQ.vue';
import { useLiveQuery } from '@electric-sql/pglite-vue';

const search = ref('');

const { selected } = defineProps({
	selected: { type: Array, default: () => [] },
});

const emit = defineEmits(['select']);

const isSelected = (address) => {
	return selected.findIndex((a) => a === address) > -1;
};

// Query all user_cards
const dbUsers = useLiveQuery(`SELECT * from user_cards ORDER BY name ASC;`);

const users = computed(() => {
	return (dbUsers?.rows?.value ?? []).map(u => ({
		...u,
		address: u.user_hash // Alias for Account_Item compatibility
	}));
});

const hasContacts = computed(() => {
	return users.value.length > 0;
});

const select = (address) => {
	emit('select', address);
};

const filteredList = computed(() => {
	let list = users.value;
	let searchTerm;
	
	if (search.value) {
		searchTerm = search.value.toLowerCase();
		list = list.filter((c) => [c.name, c.user_hash].some((value) => value && value.toLowerCase().includes(searchTerm)));
	}

	const l = list.map((c) => ({
		...c,
		highlightedName: highlightText(c.name, searchTerm),
		highlightedAddress: highlightText(c.user_hash, searchTerm),
	}));

	return l;
});

function highlightText(text, searchTerm) {
	if (!searchTerm || !text) return text;
	const regex = new RegExp(`(${searchTerm})`, 'gi');
	return text.replace(regex, `<span class="_highlight_search_text">$1</span>`);
}
</script>