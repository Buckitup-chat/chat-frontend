// @vitest-environment jsdom
// The gallery viewer: one component for the chat's picture carousel and for
// profile-photo galleries (pq_avatars), counter, arrows, keys, swipe, strip.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import GalleryViewer from '@/components/GalleryViewer.vue';

const frames = (n) => Array.from({ length: n }, (_, i) => ({
	key: `k${i}`, src: i === 0 ? 'blob:first' : '', placeholder: `data:image/png;base64,p${i}`, alt: `photo ${i}`,
}));

// A parent that owns the index, the way both callers do.
const render = (list, { index = 0, countJoin, slots } = {}) => {
	const w = mount(GalleryViewer, {
		props: {
			frames: list, index, ...(countJoin ? { countJoin } : {}),
			'onUpdate:index': (i) => w.setProps({ index: i }),
		},
		slots,
		attachTo: document.body,
	});
	return w;
};

describe('GalleryViewer', () => {
	it('counts "2 of 5" with the profile wording, "2 / 5" by default', async () => {
		const profile = render(frames(5), { index: 1, countJoin: 'of' });
		const chat = render(frames(5), { index: 1 });
		expect(profile.find('.lightbox-count').text()).toBe('2 of 5');
		expect(chat.find('.lightbox-count').text()).toBe('2 / 5');
		profile.unmount();
		chat.unmount();
	});

	it('steps with the arrows and wraps at both ends', async () => {
		const w = render(frames(3));
		await w.find('.lightbox-nav._prev').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('3 / 3');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('1 / 3');
		w.unmount();
	});

	it('steps with the arrow keys and closes on Escape', async () => {
		const w = render(frames(3));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
		await w.vm.$nextTick();
		expect(w.find('.lightbox-count').text()).toBe('2 / 3');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
		await w.vm.$nextTick();
		expect(w.find('.lightbox-count').text()).toBe('1 / 3');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(w.emitted('close')).toHaveLength(1);
		w.unmount();
	});

	it('a horizontal swipe steps; a vertical move or a short one does not', async () => {
		const w = render(frames(3));
		const swipe = async (dx, dy) => {
			await w.find('.lightbox').trigger('touchstart', { touches: [{ clientX: 200, clientY: 200 }] });
			await w.find('.lightbox').trigger('touchend', { changedTouches: [{ clientX: 200 + dx, clientY: 200 + dy }] });
		};
		await swipe(-80, 5);
		expect(w.find('.lightbox-count').text()).toBe('2 / 3');
		await swipe(80, 0);
		expect(w.find('.lightbox-count').text()).toBe('1 / 3');
		await swipe(-20, 0);
		await swipe(-50, 120);
		expect(w.find('.lightbox-count').text()).toBe('1 / 3');
		w.unmount();
	});

	it('shows the picture when it is here and its blur until then, dimming the strip for what is missing', async () => {
		const w = render(frames(2));
		expect(w.find('.lightbox-frame img').attributes('src')).toBe('blob:first');
		await w.find('.lightbox-nav._next').trigger('click');
		expect(w.find('.lightbox-frame img').classes()).toContain('_blur');
		const thumbs = w.findAll('.lightbox-thumb');
		expect(thumbs[0].classes()).not.toContain('_pending');
		expect(thumbs[1].classes()).toContain('_pending');
		w.unmount();
	});

	it('a strip thumb jumps to its frame; one frame has no arrows and no strip', async () => {
		const w = render(frames(4));
		await w.findAll('.lightbox-thumb')[2].trigger('click');
		expect(w.find('.lightbox-count').text()).toBe('3 / 4');
		w.unmount();
		const one = render(frames(1));
		expect(one.find('.lightbox-nav').exists()).toBe(false);
		expect(one.find('.lightbox-strip').exists()).toBe(false);
		one.unmount();
	});

	it('hands the shown frame to the actions slot', async () => {
		const w = render(frames(3), {
			index: 2,
			slots: { actions: ({ frame, index }) => h('span', { class: 'act' }, `${frame.key}@${index}`) },
		});
		expect(w.find('.act').text()).toBe('k2@2');
		w.unmount();
	});
});
