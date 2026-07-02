import { ref, computed, reactive } from 'vue';

const width = ref(typeof window !== 'undefined' ? window.innerWidth : 0);
const breakPoints = { xs: 0, sm: 690, md: 768, lg: 992, xl: 1200, xxl: 1400 };
const list = Object.keys(breakPoints);

const bpIndex = (bp) => list.findIndex(e => e === bp);

const current = computed(() => {
    let currentBP = 'xs';
    list.forEach(k => {
        if (width.value >= breakPoints[k]) {
            currentBP = k;
        }
    });
    return currentBP;
});

const currentIndex = computed(() => list.findIndex(e => e === current.value));

const breakpointInstance = reactive({
    get width() { return width.value; },
    breakPoints,
    list,
    get current() { return current.value; },
    get currentIndex() { return currentIndex.value; },
    gt: (bp) => bpIndex(bp) < currentIndex.value,
    gte: (bp) => bpIndex(bp) <= currentIndex.value,
    lt: (bp) => bpIndex(bp) > currentIndex.value,
    lte: (bp) => bpIndex(bp) >= currentIndex.value,
    btw: (bp1, bp2) => bpIndex(bp1) < currentIndex.value && bpIndex(bp2) > currentIndex.value,
    btwe: (bp1, bp2) => bpIndex(bp1) <= currentIndex.value && bpIndex(bp2) >= currentIndex.value,
    eq: (bp) => bpIndex(bp) === currentIndex.value,
    ne: (bp) => bpIndex(bp) !== currentIndex.value,
    in: (bpList) => !!bpList.find(bp => bpIndex(bp) === currentIndex.value),
    nin: (bpList) => !bpList.find(bp => bpIndex(bp) === currentIndex.value),
    bpIndex,
    init: () => {
        width.value = window.innerWidth;
        window.addEventListener("resize", (event) => {
            width.value = event.target.innerWidth;
        });
    }
});

export function useBreakpoint() {
    return breakpointInstance;
}
