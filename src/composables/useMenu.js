import { ref } from 'vue';

// Global singleton state
const isOpen = ref(true);

export function useMenu() {
	const open = () => {
		isOpen.value = true;
	};

	const close = () => {
		isOpen.value = false;
	};

	return {
		isOpen,
		open,
		close,
	};
}
