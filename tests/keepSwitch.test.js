// @vitest-environment jsdom
// The "Keep on this device" switch in the file state screen, driven by
// useKeptFiles over the real kept-files layer: the chunk cache on
// fake-indexeddb, real verification and AES-GCM, a faked server
// (helpers/fileServer.ts). The switch shows what is: on once the file is
// kept, and back off — with the reason said — when keeping it failed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { defineComponent, h, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { cards, installFakeServer, publishFile, serve } from './helpers/fileServer';
import { failWritesWithQuota } from './helpers/idbQuota';

vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash) => cards[hash] ?? null }));

const { __resetChunkCacheForTests, pinnedBytesOf } = await import('@/lib/data/chunkCache');
const { _setKeptFilesStoreForTests, listKeptFiles } = await import('@/lib/data/keptFiles');
const { useKeptFiles } = await import('@/composables/useKeptFiles');
const { fileKey } = await import('@/lib/data/fileKey');
const FileStateModal = (await import('@/components/chat/FileStateModal.vue')).default;

const OWNER = 'u_' + '1'.repeat(128);
const messageId = 'dmsg_1';
const availability = { present: 2, total: 2, unknown: false, deleted: false };

let server;
let accountKey;
beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	__resetChunkCacheForTests();
	const raw = new Map();
	accountKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	_setKeptFilesStoreForTests({
		get: async (k) => raw.get(k) ?? null,
		set: async (k, v) => { raw.set(k, v); },
		delete: async (k) => { raw.delete(k); },
		keys: async () => [...raw.keys()],
		clear: async () => raw.clear(),
	}, async () => accountKey);
	server = installFakeServer();
});

/** The screen as the chat page binds it. */
const mountScreen = (part) => {
	const errorsTold = [];
	const Harness = defineComponent({
		setup() {
			const owner = ref(OWNER);
			const k = useKeptFiles({ owner: () => owner.value, onError: (message) => errorsTold.push(message) });
			return () => h(FileStateModal, {
				part,
				availability,
				kept: !!k.kept.value[fileKey(part)],
				keeping: k.keeping.value[fileKey(part)] || null,
				keepError: k.errors.value[fileKey(part)] || '',
				onKeep: (on) => k.setKept(part, messageId, on),
			});
		},
	});
	return { wrapper: mount(Harness), errorsTold };
};

const settle = async () => {
	for (let i = 0; i < 40; i++) {
		await flushPromises();
		await new Promise((r) => setTimeout(r, 5));
	}
};

const toggle = async (wrapper, on) => {
	const input = wrapper.find('#fs-keep');
	input.element.checked = on;
	await input.trigger('change');
};

describe('the keep switch', () => {
	it('keeps the file: the switch stays on and says what keeping means', async () => {
		const f = await publishFile('f_' + '4'.repeat(32), ['one ', 'two']);
		serve(server, f);
		const { wrapper, errorsTold } = mountScreen(f.part);
		await settle();
		expect(wrapper.find('#fs-keep').element.checked).toBe(false);

		await toggle(wrapper, true);
		await settle();
		expect(wrapper.find('#fs-keep').element.checked).toBe(true);
		expect(wrapper.text()).toContain('Kept on this device');
		expect(errorsTold).toEqual([]);
		expect(Object.keys(await listKeptFiles(OWNER))).toEqual([fileKey(f.part)]);
	});

	it('a pinned write that does not fit turns the switch back off and says so', async () => {
		const f = await publishFile('f_' + '5'.repeat(32), ['first ', 'second']);
		serve(server, f);
		const { wrapper, errorsTold } = mountScreen(f.part);
		await settle();

		const restore = failWritesWithQuota((v) => v?.key === `${f.fileId}:1`);
		try {
			await toggle(wrapper, true);
			await settle();
		} finally {
			restore();
		}
		const input = wrapper.find('#fs-keep').element;
		expect(input.checked).toBe(false);
		expect(input.disabled).toBe(false);
		expect(wrapper.find('.fs-refused').text()).toBe('There is not enough storage on this device to keep this file.');
		expect(errorsTold).toEqual(['There is not enough storage on this device to keep this file.']);
		expect(await listKeptFiles(OWNER)).toEqual({});
		expect(await pinnedBytesOf(OWNER)).toBe(0);
	});

	it('turning it off lets the file go', async () => {
		const f = await publishFile('f_' + '6'.repeat(32), ['bye']);
		serve(server, f);
		const { wrapper } = mountScreen(f.part);
		await settle();
		await toggle(wrapper, true);
		await settle();
		await toggle(wrapper, false);
		await settle();
		expect(wrapper.find('#fs-keep').element.checked).toBe(false);
		expect(await listKeptFiles(OWNER)).toEqual({});
		expect(await pinnedBytesOf(OWNER)).toBe(0);
	});
});
