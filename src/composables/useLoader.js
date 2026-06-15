import { reactive } from 'vue';

const loaderInstance = reactive({
    enabled: false,
    show() {
        this.enabled = true;
    },
    hide() {
        this.enabled = false;
    }
});

export function useLoader() {
    return loaderInstance;
}
