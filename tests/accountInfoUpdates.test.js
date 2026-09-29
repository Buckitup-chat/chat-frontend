// @vitest-environment jsdom
// Account_Info emits `update` for an edit and nothing else. Its copy of the
// account is also reset whenever the prop changes, and the contact page saves
// every update and hands back a new prop: echoing the reset as an update made
// that an endless loop of signed writes while the page stayed open.
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({}) }));

const { default: Account_Info } = await import('@/components/Account_Info.vue');

describe('Account_Info updates', () => {
	it('emits an edit once, and does not echo the prop it is handed back', async () => {
		setActivePinia(createPinia());
		const saves = [];
		// The contact page: save the update, then pass a fresh object down.
		const Parent = defineComponent({
			setup() {
				const contact = ref({ user_hash: 'u_a', name: 'Ann', notes: '' });
				const onUpdate = (next) => {
					saves.push(next.name);
					contact.value = { ...contact.value, ...next };
				};
				return () => h(Account_Info, { accountIn: contact.value, onUpdate });
			},
		});
		const wrapper = mount(Parent, {
			global: {
				provide: { $swal: {}, $mitt: { emit() {} }, $encryptionManagerPQ: null },
				stubs: { Avatar: true },
				mocks: { $filters: { txHashShort: (s) => s } },
			},
		});
		await flushPromises();
		expect(saves).toEqual([]);

		const input = wrapper.find('#name');
		await input.setValue('Anna');
		for (let i = 0; i < 5; i++) {
			await nextTick();
			await flushPromises();
		}
		expect(saves).toEqual(['Anna']);
	});

	it('an edit back to the value it started from is still an edit', async () => {
		setActivePinia(createPinia());
		const drafts = [];
		// The account page: keep the latest draft, save only on a button.
		const Parent = defineComponent({
			setup() {
				const account = ref({ user_hash: 'u_a', name: 'Bob', notes: '' });
				return () => h(Account_Info, { accountIn: account.value, onUpdate: (next) => drafts.push(next.name) });
			},
		});
		const wrapper = mount(Parent, {
			global: {
				provide: { $swal: {}, $mitt: { emit() {} }, $encryptionManagerPQ: null },
				stubs: { Avatar: true },
				mocks: { $filters: { txHashShort: (s) => s } },
			},
		});
		await flushPromises();
		const input = wrapper.find('#name');
		await input.setValue('Bobx');
		await flushPromises();
		await input.setValue('Bob');
		await flushPromises();
		expect(drafts.at(-1)).toBe('Bob');
	});
});
